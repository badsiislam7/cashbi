/**
 * Transaction memory pool with:
 *  - signature/structural verification on entry,
 *  - nonce-window and balance sanity checks against the tip state,
 *  - gas-price priority ordering and a bounded size,
 *  - removal on inclusion (called by the blockchain via mempoolRef).
 */
import {
  sortTransactions,
  txHash,
  validateTransaction,
  recoverTransactionSender,
  type Transaction,
} from "./transaction.js";
import type { WorldState } from "../state/world.js";
import { MAX_MEMPOOL_TXS, } from "../config/params.js";

export interface MempoolStats {
  size: number;
  pendingSenders: number;
}

export interface MempoolAddResult {
  added: boolean;
  reason?: string;
  hash: string;
}

export class Mempool {
  private readonly byHash = new Map<string, Transaction>();
  private ready: Transaction[] | null = null; // lazily-built sorted snapshot
  private stop = false;
  private chainId: number | null = null;

  /** Records the chain id used for sender recovery in stats(). */
  setChainId(chainId: number): void {
    this.chainId = chainId;
  }

  close(): void {
    this.stop = true;
  }

  add(
    tx: Transaction,
    ctx: { chainId: number; state: WorldState; allowUnknownSender?: boolean },
  ): MempoolAddResult {
    const hash = txHash(tx);
    if (this.stop) return { added: false, reason: "mempool closed", hash };
    if (this.byHash.has(hash)) return { added: false, reason: "duplicate", hash };
    if (this.byHash.size >= MAX_MEMPOOL_TXS) return { added: false, reason: "mempool full", hash };

    let sender: string;
    try {
      const { sender: recovered } = validateTransaction(tx, {
        chainId: ctx.chainId,
        senderNonce: 0n, // full nonce check runs against the tip state below
        senderBalance: 2n ** 256n - 1n,
      });
      sender = recovered;
    } catch (err) {
      return { added: false, reason: `invalid: ${(err as Error).message}`, hash };
    }

    const account = ctx.state.getAccount(sender);
    const senderNonce = account ? account.nonce : 0n;
    if (tx.nonce < senderNonce) {
      return { added: false, reason: `nonce too low (account at ${senderNonce})`, hash };
    }
    const maxSpend = tx.value + tx.gas * tx.gasPrice;
    if (account && account.balance < maxSpend) {
      return { added: false, reason: "insufficient balance at tip", hash };
    }

    this.byHash.set(hash, tx);
    this.ready = null;
    return { added: true, hash };
  }

  remove(hash: string): boolean {
    if (!this.byHash.has(hash)) return false;
    this.byHash.delete(hash);
    this.ready = null;
    return true;
  }

  /**
   * Sorted candidate snapshot (descending gas price): callers pick a
   * contiguous nonce-consistent prefix per account and stop at the first
   * account whose sequence breaks (the miner then re-queries).
   */
  snapshot(): Transaction[] {
    if (!this.ready) {
      this.ready = sortTransactions([...this.byHash.values()]);
    }
    return this.ready;
  }

  stats(): MempoolStats {
    const senders = new Set<string>();
    const effectiveChainId = this.chainId ?? 0;
    for (const tx of this.byHash.values()) {
      try {
        senders.add(recoverTransactionSender(tx, effectiveChainId));
      } catch {
        senders.add(txHash(tx));
      }
    }
    return { size: this.byHash.size, pendingSenders: senders.size };
  }

  has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  get(hash: string): Transaction | null {
    return this.byHash.get(hash) ?? null;
  }

  all(): Transaction[] {
    return [...this.byHash.values()];
  }
}
