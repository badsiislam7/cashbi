/**
 * Block template construction for mining:
 *  - selects a nonce-consistent transaction prefix from the mempool,
 *  - replays it against a chosen parent's state to compute the post state
 *    root,
 *  - computes header fields (difficulty via retarget, gas accounting),
 *  - performs the coinbase reward inside the template state so the
 *    finalized header passes validation unchanged.
 *
 * Two entry points:
 *   buildBlockForMining(...) — mine on the current tip.
 *   buildBlockOn(...)        — mine on an arbitrary parent (fork mining).
 */
import type { Block, BlockHeader } from "../chain/block.js";
import { transactionsRoot, blockHash } from "../chain/block.js";
import type { Blockchain } from "../chain/blockchain.js";
import type { Mempool } from "../tx/mempool.js";
import { Journal } from "../state/world.js";
import { sortTransactions, txHash as txHashOf, recoverTransactionSender, type Transaction } from "../tx/transaction.js";
import { nextDifficulty, RETARGET_OLDEST_ANCHOR_OFFSET, virtualAnchorTimestamp } from "../consensus/pow.js";
import { cappedReward } from "../consensus/issuance.js";
import { DIFFICULTY_RETARGET_INTERVAL, MAX_BLOCK_GAS, MAX_TIMESTAMP_STEP_SECONDS } from "../config/params.js";
import { TransactionExecutor } from "../tx/execute.js";
import type { WorldState as RealWorldState } from "../state/world.js";

export interface CandidateInput {
  chain: Blockchain;
  mempool: Mempool;
  coinbase: string;
  timestamp: number;
  activeReward: bigint;
  extraData: Uint8Array;
}

/** Mines on the current chain tip. */
export function buildBlockForMining(input: CandidateInput): Block | null {
  const tip = input.chain.tip;
  return buildBlockOn(input, {
    parentHash: tip.hash,
    parentBlock: tip.block,
    parentState: input.chain.tipState,
  });
}

export interface ForkParentSpec {
  parentHash: string;
  parentBlock: Block;
  parentState: unknown;
}

/**
 * Builds a block template extending a specific parent — the primitive that
 * makes real fork mining possible. `parentState` must be the post-state of
 * the parent block; Blockchain.getState(parentHash) supplies it.
 */
export function buildBlockOn(
  input: CandidateInput,
  parent: { parentHash: string; parentBlock: Block; parentState: unknown /* WorldState */ },
): Block | null {
  const state0 = parent.parentState;
  if (!state0 || typeof (state0 as WorldStateLike).clone !== "function") return null;
  const parentState = state0 as WorldStateLike;
  const parentTs = parent.parentBlock.header.timestamp;

  // Parent-relative stamp policy for locally built candidates. The miner
  // supplies a wall-clock suggestion (floor(now/1000)); the template clamps
  // it into the consensus range [parentTs, parentTs + MAX_TIMESTAMP_STEP_SECONDS]:
  //  - normally the suggestion already satisfies the range (wall clock has
  //    passed the parent's stamp), so behavior is unchanged;
  //  - when chain lags wall clock by more than one target interval (e.g. an
  //    old dev genesis timestamp), every candidate deterministically advances
  //    chain time by the maximum step (equal stamps keep the slow case
  //    working too). MAX_TIMESTAMP_STEP_SECONDS = one target interval.
  const timestamp = Math.min(Math.max(input.timestamp, parentTs), parentTs + MAX_TIMESTAMP_STEP_SECONDS);

  let difficulty: bigint;
  try {
    difficulty = nextDifficulty(
      parent.parentBlock.header.difficulty,
      parent.parentBlock.header.number,
      timestamp,
      branchTimestampLookup(input.chain, parent.parentBlock, parent.parentBlock.header.number + 1, timestamp),
    );
  } catch {
    // Retarget anchor history unavailable on this branch -> no template.
    return null;
  }

  // Greedy fee-sorted selection with per-sender nonce sequencing.
  const state = parentState.clone();
  const executor = new TransactionExecutor(input.chain.chainId);
  const chosen: Transaction[] = [];
  let gasUsedTotal = 0n;

  // Skip txs already included in THIS parent (fork reuse would double-run).
  const included = new Set(parent.parentBlock.transactions.map((tx) => txHashOf(tx)));
  const candidates = sortTransactions(input.mempool.snapshot())
    .concat(parent.parentBlock.transactions)
    .filter((tx) => !included.has(txHashOf(tx)));

  const senderProgress = new Map<string, bigint>();
  for (const tx of candidates) {
    const sender = recoverOrNull(input.chain.chainId, tx);
    if (sender === null) continue;
    const expected = senderProgress.get(sender) ?? state.getAccount(sender)?.nonce ?? 0n;
    if (tx.nonce !== expected) continue;
    try {
      const receipt = executor.execute(tx, state, {
        chainId: input.chain.chainId,
        coinbase: input.coinbase,
        blockNumber: parent.parentBlock.header.number + 1,
        blockTimestamp: timestamp,
      });
      senderProgress.set(sender, tx.nonce + 1n);
      gasUsedTotal += receipt.gasUsed;
      chosen.push(tx);
    } catch {
      continue;
    }
  }

  // Coinbase block reward — SAME capped-issuance semantics as validation
  // (src/chain/blockchain.ts): clamp the subsidy to the remaining mintable
  // supply so templates and validators agree on the post state at the cap
  // boundary and in the zero-reward tail.
  const reward = cappedReward(input.activeReward, state.totalSupply());
  if (reward > 0n) {
    const journal = new Journal(state);
    const coinbase = journal.ensureAccount(input.coinbase);
    coinbase.balance += reward;
    journal.applyTo(state);
  }

  const header: BlockHeader = {
    parentHash: parent.parentHash,
    number: parent.parentBlock.header.number + 1,
    timestamp,
    difficulty,
    coinbase: input.coinbase,
    extraData: input.extraData,
    gasLimit: MAX_BLOCK_GAS,
    gasUsed: gasUsedTotal,
    transactionsRoot: transactionsRoot(chosen),
    stateRoot: state.stateRoot(),
    nonce: 0n,
  };
  return { header, transactions: chosen };
}

/**
 * Branch-aware anchor lookup for template building (mirrors Blockchain's
 * retarget rule): walks parent hashes from the mining parent, synthesizes
 * heights < 0 from the genesis timestamp, and resolves height h to the
 * candidate stamp. Understands the genesis manifest's timestamp; throws if a
 * needed real block is unavailable so the caller can bail out cleanly.
 */
function branchTimestampLookup(
  chain: Blockchain,
  parentBlock: Block,
  retargetHeight: number,
  candidateTimestamp: number,
): (height: number) => number {
  if ((parentBlock.header.number + 1) % DIFFICULTY_RETARGET_INTERVAL !== 0) {
    // Non-retarget height: nextDifficulty ignores the lookup; fail loudly if
    // it is ever consulted by mistake.
    return (height) => {
      throw new Error(`height ${height} is not a retarget anchor (non-retarget height)`);
    };
  }
  const genesisTimestamp = chain.genesis.genesisTimestamp;

  const branchTs = new Map<number, number>();
  let cursor: Block | null = parentBlock;
  while (cursor && cursor.header.number >= retargetHeight - RETARGET_OLDEST_ANCHOR_OFFSET) {
    branchTs.set(cursor.header.number, cursor.header.timestamp);
    if (cursor.header.number === 0) break;
    cursor = chain.getBlock(cursor.header.parentHash)?.block ?? null;
  }
  return (height: number): number => {
    if (height < 0) return virtualAnchorTimestamp(height, genesisTimestamp);
    if (height === retargetHeight) return candidateTimestamp;
    const ts = branchTs.get(height);
    if (ts !== undefined) return ts;
    // Fork-retention pruning may have removed canonical ancestors needed by
    // the anchor walk. Fall back to the chain's best-chain timestamp ledger
    // ONLY for templates mined on the canonical best tip (buildBlockForMining
    // passes it as parentBlock); fork templates fail deterministically
    // instead of silently reading another branch's timestamps.
    if (blockHash(parentBlock.header) === chain.tip.hash) {
      const ledgerTs = chain.getBestChainTimestampAt(height);
      if (ledgerTs !== undefined) return ledgerTs;
    }
    throw new Error(`no block on this branch at anchor height ${height}`);
  };
}

interface WorldStateLike {
  clone(): RealWorldState;
  getAccount(address: string): { nonce: bigint } | null;
  stateRoot(): string;
}

function recoverOrNull(chainId: number, tx: Transaction): string | null {
  try {
    return recoverTransactionSender(tx, chainId);
  } catch {
    return null;
  }
}
