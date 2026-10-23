/**
 * Transaction execution: EVM-driven state transitions with fee handling.
 * The gas price paid by senders goes fully to the coinbase (no EIP-1559 fee
 * split — dev simplification, decision D-9 open).
 *
 * Execution model:
 *  1. Recover sender (signature) and check replay rules (nonce, chain id).
 *  2. Reserve value + gas*gasPrice up front (prevents overdraft).
 *  3. Run EVM (call or create).
 *  4. Success: commit changes, bump nonce, refund unused gas to sender,
 *     pay used gas to coinbase.
 *  5. Failure: roll the journal back to the pre-transaction checkpoint,
 *     bump nonce, charge the FULL gas limit (dev rule), pay it to coinbase.
 *     The tx still lands in the block; the receipt records the error.
 */
import { Journal, WorldState } from "../state/world.js";
import { CREATE_TX_GAS, CONSENT_TX_GAS } from "../config/params.js";
import { EVM, contractAddress } from "../vm/evm.js";
import { recoverTransactionSender, txHash, type Transaction } from "../tx/transaction.js";

export interface ExecutionContext {
  chainId: number;
  coinbase: string;
  blockNumber: number;
  blockTimestamp: number;
}

export interface TxExecutionReceipt {
  txHash: string;
  sender: string;
  contractAddress?: string;
  gasUsed: bigint;
  ok: boolean;
  error?: string;
  revertData?: Uint8Array;
}

export class TransactionExecutor {
  constructor(private readonly chainId: number) {}

  execute(tx: Transaction, state: WorldState, ctx: ExecutionContext): TxExecutionReceipt {
    const hash = txHash(tx);
    const sender = recoverTransactionSender(tx, this.chainId);

    const journal = new Journal(state);
    const senderAccount = journal.ensureAccount(sender);

    if (senderAccount.nonce !== tx.nonce) {
      // Nonce mismatch is a consensus-level rejection, not a gas-charging event.
      throw new Error(`nonce mismatch: account is at ${senderAccount.nonce}, tx is ${tx.nonce}`);
    }

    const baseGas = tx.to ? CONSENT_TX_GAS : CREATE_TX_GAS;
    if (tx.gas < baseGas) {
      // Ethereum semantics: intrinsic gas (21000 for transfers) is sufficient.
      throw new Error("gas below intrinsic base transaction gas");
    }

    const maxCharge = tx.value + tx.gas * tx.gasPrice;
    const checkpoint = journal.snapshot();
    const receipt: TxExecutionReceipt = { txHash: hash, sender, gasUsed: 0n, ok: false };

    try {
      if (senderAccount.balance < maxCharge) {
        throw new Error("insufficient balance for value + gas");
      }
      // Reserve the gas side only; the value side moves through
      // journal.transfer below exactly once (single deduction).
      senderAccount.balance -= tx.gas * tx.gasPrice;

      let evmGas = 0n;
      if (tx.to === null) {
        const address = contractAddress(sender, tx.nonce);
        receipt.contractAddress = address;
        journal.transfer(sender, address, tx.value);
        const evm = new EVM(
          journal,
          tx.data,
          {
            caller: sender,
            address,
            value: tx.value,
            callData: new Uint8Array(0),
            blockTimestamp: ctx.blockTimestamp,
            blockNumber: ctx.blockNumber,
            gasPrice: tx.gasPrice,
          },
          tx.gas - baseGas,
        );
        const result = evm.run();
        if (!result.ok) throw new RevertSignal(result.error ?? "contract creation aborted", result.output);
        journal.setAccount(address, { balance: 0n, nonce: 0n, code: result.output, storage: new Map() });
        evmGas = result.gasUsed;
      } else {
        const toAccount = journal.ensureAccount(tx.to);
        journal.transfer(sender, tx.to, tx.value);
        if (toAccount.code.length > 0) {
          const evm = new EVM(
            journal,
            toAccount.code,
            {
              caller: sender,
              address: tx.to,
              value: tx.value,
              callData: tx.data,
              blockTimestamp: ctx.blockTimestamp,
              blockNumber: ctx.blockNumber,
              gasPrice: tx.gasPrice,
            },
            tx.gas - baseGas,
          );
          const result = evm.run();
          if (!result.ok) {
            throw new RevertSignal(result.error ?? "contract call reverted", result.output);
          }
          evmGas = result.gasUsed;
        }
      }
      receipt.ok = true;
      receipt.gasUsed = baseGas + evmGas;
      const refund = tx.gas - receipt.gasUsed;
      addBalance(journal, sender, refund * tx.gasPrice);
      addBalance(journal, ctx.coinbase, receipt.gasUsed * tx.gasPrice);
    } catch (err) {
      journal.restoreTo(checkpoint);
      const revert = err instanceof RevertSignal ? err : null;
      receipt.gasUsed = tx.gas; // dev rule: full gas charged on failure
      receipt.error = (err as Error).message;
      if (revert) receipt.revertData = revert.output;
      // Nonce still bumps; full gas still burns (paid to coinbase).
      const acc = journal.ensureAccount(sender);
      acc.nonce = tx.nonce + 1n;
      acc.balance -= tx.gas * tx.gasPrice;
      const cb = journal.ensureAccount(ctx.coinbase);
      cb.balance += tx.gas * tx.gasPrice;
    }

    journal.applyTo(state);
    return receipt;
  }
}

class RevertSignal extends Error {
  constructor(message: string, public readonly output: Uint8Array) {
    super(message);
  }
}

function addBalance(journal: Journal, address: string, amount: bigint): void {
  if (amount <= 0n) return;
  const account = journal.ensureAccount(address);
  account.balance += amount;
}
