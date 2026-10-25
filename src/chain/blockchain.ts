/**
 * Block cache, validation, fork selection and reorganization handling.
 *
 * Scheme (dev-appropriate; see UNRESOLVED_DECISIONS.md D-14..D-17):
 * - Blocks live in an in-memory Map keyed by header hash, each retaining its
 *   post-execution WorldState so that forks can be compared by cumulative
 *   difficulty without replaying from genesis.
 * - Losing-fork states are retained up to FORK_RETENTION blocks to allow
 *   cheap re-switching.
 * - Missing-parent blocks are queued (bounded) and retried on every accepted
 *   block so out-of-order sync converges.
 * - Persistence is an append-only JSONL ledger of canonical encodings.
 */
import type { Block } from "./block.js";
import { blockHash, decodeBlock, encodeBlock, transactionsRoot } from "./block.js";
import type { Transaction } from "../tx/transaction.js";
import { recoverTransactionSender, validateTransaction, txHash } from "../tx/transaction.js";
import { Journal, WorldState } from "../state/world.js";
import { TransactionExecutor, type ExecutionContext, type TxExecutionReceipt } from "../tx/execute.js";
import { nextDifficulty, verifyHeaderPoW, virtualAnchorTimestamp } from "../consensus/pow.js";
import { BLOCK_REWARD, DIFFICULTY_RETARGET_INTERVAL, MAX_BLOCK_BYTES, MAX_FUTURE_TIMESTAMP_SECONDS, MAX_TIMESTAMP_STEP_SECONDS, MAX_TOTAL_SUPPLY, MAX_PENDING_BLOCKS } from "../config/params.js";
import { isValidAddress } from "../crypto/keys.js";
import { appendLedger, readLedger } from "./persist.js";
import { buildGenesis, type GenesisConfig, type GenesisManifest, genesisManifest } from "./genesis.js";

export interface ImportedReceipt {
  accepted?: boolean;
  reason?: string;
  reorganized: boolean;
  tipNumber: number;
  tipHash: string;
}

interface ChainIndexEntry {
  block: Block;
  hash: string;
  state: WorldState;
  /** Cumulative PoW difficulty from genesis. */
  score: bigint;
  receipts: TxExecutionReceipt[];
}

const FORK_RETENTION = 512;

export class Blockchain {
  private readonly byHash = new Map<string, ChainIndexEntry>();
  private readonly byHeight = new Map<number, string>(); // best chain only
  private readonly children = new Map<string, string[]>(); // parentHash -> child hashes
  private readonly pending = new Map<string, Block>(); // blocks awaiting their parent
  private bestHash!: string;
  private bestBlock!: Block;
  private bestState!: WorldState;
  private genesisManifestValue: GenesisManifest;
  private readonly executor: TransactionExecutor;
  private ledgerFile: string | null = null;
  /** Injected by node wiring so accepted txs are dropped from mempools. */
  mempoolRef: { remove(hash: string): void } | null = null;

  constructor(private readonly config: GenesisConfig) {
    this.executor = new TransactionExecutor(config.chainId);
    const genesis = buildGenesis(config);
    const hash = blockHash(genesis.block.header);
    this.bestHash = hash;
    this.bestBlock = genesis.block;
    this.bestState = genesis.state;
    this.byHash.set(hash, {
      block: genesis.block,
      hash,
      state: genesis.state,
      score: genesis.block.header.difficulty,
      receipts: [],
    });
    this.byHeight.set(0, hash);
    this.children.set(EMPTY_HASH, [hash]);
    this.genesisManifestValue = genesisManifest(config);
  }

  get genesis(): GenesisManifest {
    return this.genesisManifestValue;
  }

  get chainId(): number {
    return this.config.chainId;
  }

  get tip(): { hash: string; number: number; block: Block } {
    return { hash: this.bestHash, number: this.bestBlock.header.number, block: this.bestBlock };
  }

  get bestScore(): bigint {
    return this.byHash.get(this.bestHash)!.score;
  }

  enablePersistence(filePath: string): void {
    this.ledgerFile = filePath;
  }

  /** Rebuilds the chain from a persisted JSONL ledger. */
  static loadFromLedger(config: GenesisConfig, filePath: string): Blockchain {
    const chain = new Blockchain(config);
    for (const raw of readLedger(filePath)) {
      chain.tryImport(decodeBlock(raw));
    }
    return chain;
  }

  getBlock(hash: string): { block: Block; receipts: TxExecutionReceipt[] } | null {
    const entry = this.byHash.get(hash);
    if (!entry) return null;
    return { block: entry.block, receipts: entry.receipts };
  }

  getBlockByNumber(number: number): Block | null {
    const hash = this.byHeight.get(number);
    if (!hash) return null;
    return this.byHash.get(hash)!.block;
  }

  /** Post-execution state for any retained block (fork mining support). */
  getState(hash: string): WorldState | null {
    const entry = this.byHash.get(hash);
    if (!entry) return null;
    return entry.state;
  }

  /** The live world state of the tip (mutated only by consensus execution). */
  get tipState(): WorldState {
    return this.bestState;
  }

  childrenOf(parentHash: string): string[] {
    return this.children.get(parentHash) ?? [];
  }

  /**
   * Validates and imports a block (possibly out of order). Retries pending
   * children afterwards so gap-filling converges.
   */
  acceptBlock(block: Block): ImportedReceipt & { accepted: boolean } {
    const preTip = this.tip.hash;
    const first = this.tryImport(block);
    const pendingSnapshot = [...this.pending.values()];
    this.pending.clear();
    for (const candidate of pendingSnapshot) {
      this.tryImport(candidate);
    }
    const result = this.tip;
    const acceptedNow = this.byHash.has(blockHash(block.header));
    return {
      accepted: acceptedNow,
      reason: first.reason && !acceptedNow ? first.reason : undefined,
      reorganized: result.hash !== preTip,
      tipNumber: result.number,
      tipHash: result.hash,
    };
  }

  private tryImport(block: Block): ImportedReceipt {
    const reject = (reason: string): ImportedReceipt => ({ ...this.tipInfo(), reorganized: false, reason });
    const parentHash = block.header.parentHash;
    const parent = this.byHash.get(parentHash);
    if (!parent) {
      if (this.pending.size < MAX_PENDING_BLOCKS) this.pending.set(blockHash(block.header), block);
      return reject("unknown parent (queued)");
    }
    if (block.header.number !== parent.block.header.number + 1) {
      return reject(`height ${block.header.number} does not follow parent height ${parent.block.header.number}`);
    }
    // Parent-relative deterministic timestamp rules: stamps may not move
    // backwards and may advance the parent's timestamp by at most
    // MAX_TIMESTAMP_STEP_SECONDS. Equal timestamps are explicitly valid.
    if (block.header.timestamp < parent.block.header.timestamp) {
      return reject("timestamp earlier than parent");
    }
    if (block.header.timestamp > parent.block.header.timestamp + MAX_TIMESTAMP_STEP_SECONDS) {
      return reject("timestamp more than MAX_TIMESTAMP_STEP_SECONDS seconds after parent");
    }
    // Pre-existing local-clock acceptance policy, unchanged in this phase:
    // blocks stamped beyond the local future tolerance are rejected here.
    // (A future phase replaces this with quarantine; out of scope below.)
    if (block.header.timestamp > Math.floor(Date.now() / 1000) + MAX_FUTURE_TIMESTAMP_SECONDS) {
      return reject("timestamp too far in the future");
    }
    const pow = verifyHeaderPoW(block.header, { nonce: block.header.nonce });
    if (!pow.ok) return reject(pow.reason);

    // Difficulty retarget: anchors come from THIS branch (the parent chain the
    // block extends), never from the canonical tip. The new sample includes
    // the block being validated (height h); heights below zero at the first
    // retarget are virtual anchors derived from the genesis header timestamp
    // (see pow.virtualAnchorTimestamp) — not real blocks and not consulted by
    // any other rule.
    let expectedDifficulty: bigint;
    try {
      expectedDifficulty = nextDifficulty(
        parent.block.header.difficulty,
        parent.block.header.number,
        block.header.timestamp,
        this.branchTimestampLookup(parent, block.header.number, block.header.timestamp),
      );
    } catch (err) {
      return reject(`retarget anchor data unavailable: ${(err as Error).message}`);
    }
    if (block.header.difficulty !== expectedDifficulty) {
      return reject(`difficulty ${block.header.difficulty} != retargeted ${expectedDifficulty}`);
    }
    if (block.header.gasUsed > block.header.gasLimit) {
      return reject("gasUsed exceeds gasLimit");
    }
    if (encodeBlock(block).length > MAX_BLOCK_BYTES) {
      return reject("block exceeds MAX_BLOCK_BYTES");
    }
    if (!isValidAddress(block.header.coinbase) && block.header.coinbase !== EMPTY_COINBASE) {
      return reject("invalid coinbase address");
    }
    if (transactionsRoot(block.transactions) !== block.header.transactionsRoot) {
      return reject("transactionsRoot mismatch");
    }

    // Execution against the parent's state.
    const state = parent.state.clone();
    const ctx: ExecutionContext = {
      chainId: this.config.chainId,
      coinbase: block.header.coinbase,
      blockNumber: block.header.number,
      blockTimestamp: block.header.timestamp,
    };
    const receipts: TxExecutionReceipt[] = [];
    let gasUsedTotal = 0n;
    for (const tx of block.transactions) {
      try {
        const receipt = this.execute(state, tx, ctx);
        receipts.push(receipt);
        gasUsedTotal += receipt.gasUsed;
      } catch (err) {
        // A single invalid tx must reject the block, not crash the node.
        return reject(`tx execution failed: ${(err as Error).message}`);
      }
    }
    if (!block.transactions.length && gasUsedTotal !== 0n) {
      // unreachable, defensive
      return reject("gas accounted incorrectly");
    }
    if (gasUsedTotal !== block.header.gasUsed) {
      return reject(`gasUsed ${gasUsedTotal} != header ${block.header.gasUsed}`);
    }

    // Block reward (dev issuance, decision D-1 open) + supply cap.
    if (BLOCK_REWARD > 0n) {
      // state.totalSupply() reads the backing state, not the journal overlay
      // where the reward is staged, so check against cap explicitly.
      if (state.totalSupply() + BLOCK_REWARD > MAX_TOTAL_SUPPLY) {
        return reject("max total supply would be exceeded");
      }
      const journal = new Journal(state);
      const cb = journal.ensureAccount(block.header.coinbase);
      cb.balance += BLOCK_REWARD;
      journal.applyTo(state);
    } else if (state.totalSupply() > MAX_TOTAL_SUPPLY) {
      return reject("max total supply exceeded");
    }
    if (state.stateRoot() !== block.header.stateRoot) {
      return reject("stateRoot mismatch");
    }

    // Index and fork selection.
    const hash = blockHash(block.header);
    if (this.byHash.has(hash)) return reject("duplicate block");
    const score = parent.score + block.header.difficulty;
    const entry: ChainIndexEntry = { block, hash, state, score, receipts };
    this.byHash.set(hash, entry);
    const siblings = this.children.get(parentHash) ?? [];
    siblings.push(hash);
    this.children.set(parentHash, siblings);
    this.pruneDeepForks();
    const reorganized = this.selectBestChain();
    if (this.ledgerFile) appendLedger(this.ledgerFile, encodeBlock(block));
    if (reorganized && this.mempoolRef) {
      const known = block.transactions.map((tx: Transaction) => txHash(tx));
      for (const txHashKnown of known) this.mempoolRef.remove(txHashKnown as string);
    }
    return { ...this.tipInfo(), reorganized, accepted: true };
  }

  /**
   * Builds a timestamp lookup over the branch that ends at `parent` (the
   * block's parent), covering retarget anchor heights [h-69, h-1]. Heights
   * below zero (first retarget only) are virtual anchors derived from the
   * genesis header timestamp; height h resolves to the block being validated.
   * The walk follows parent hashes — never the canonical best chain — so a
   * fork block is retargeted with its own branch's history.
   */
  private branchTimestampLookup(
    parent: ChainIndexEntry,
    blockHeight: number,
    blockTimestamp: number,
  ): (height: number) => number {
    if ((parent.block.header.number + 1) % DIFFICULTY_RETARGET_INTERVAL !== 0) {
      // Non-retarget heights never consult anchors; keep the lookup strict
      // anyway so accidental use fails loudly instead of reading wrong data.
      return (height) => {
        throw new Error(`height ${height} is not a retarget anchor (non-retarget height)`);
      };
    }
    const genesisTimestamp = this.config.timestamp; // genesis header timestamp source
    const branchTs = new Map<number, number>();
    let cursor: ChainIndexEntry | undefined = parent;
    while (cursor && cursor.block.header.number >= blockHeight - 69) {
      branchTs.set(cursor.block.header.number, cursor.block.header.timestamp);
      if (cursor.block.header.number === 0) break;
      cursor = this.byHash.get(cursor.block.header.parentHash);
    }
    return (height: number): number => {
      if (height < 0) return virtualAnchorTimestamp(height, genesisTimestamp);
      if (height === blockHeight) return blockTimestamp;
      const ts = branchTs.get(height);
      if (ts === undefined) throw new Error(`no block on this branch at anchor height ${height}`);
      return ts;
    };
  }

  private execute(
    state: WorldState,
    tx: Transaction,
    ctx: ExecutionContext,
  ): TxExecutionReceipt {
    const from = recoverTransactionSender(tx, this.config.chainId);
    const account = state.getAccount(from);
    validateTransaction(tx, {
      chainId: this.config.chainId,
      senderNonce: account ? account.nonce : 0n,
      senderBalance: account ? account.balance : 0n,
    });
    return this.executor.execute(tx, state, ctx);
  }

  tipInfo(): ImportedReceipt {
    return { tipNumber: this.tip.number, tipHash: this.tip.hash, reorganized: false };
  }

  /** Fork choice: strictly higher cumulative difficulty wins; tie → deeper. */
  private selectBestChain(): boolean {
    let best = this.byHash.get(this.bestHash)!;
    for (const entry of this.byHash.values()) {
      const deeper =
        entry.score === best.score &&
        entry.block.header.number > best.block.header.number;
      if (entry.score > best.score || deeper) best = entry;
    }
    if (best.hash === this.bestHash) return false;
    this.bestHash = best.hash;
    this.bestBlock = best.block;
    this.bestState = best.state;
    this.rebuildBestIndex();
    return true;
  }

  private rebuildBestIndex(): void {
    const hashes: string[] = [];
    let cursor: string | undefined = this.bestHash;
    while (cursor !== undefined) {
      const entry = this.byHash.get(cursor);
      if (!entry) break;
      hashes.push(cursor);
      if (entry.block.header.number === 0) break;
      cursor = entry.block.header.parentHash;
    }
    this.byHeight.clear();
    for (let i = hashes.length - 1; i >= 0; i--) {
      const entry = this.byHash.get(hashes[i])!;
      this.byHeight.set(entry.block.header.number, hashes[i]);
    }
  }

  private pruneDeepForks(): void {
    if (this.byHash.size <= FORK_RETENTION + 1) return;
    const cutoff = this.tip.number - FORK_RETENTION;
    for (const [hash, entry] of [...this.byHash.entries()]) {
      if (entry.block.header.number < cutoff && hash !== this.bestHash) {
        this.byHash.delete(hash);
        const kids = (this.children.get(entry.block.header.parentHash) ?? []).filter((h) => h !== hash);
        if (kids.length) this.children.set(entry.block.header.parentHash, kids);
        else this.children.delete(entry.block.header.parentHash);
      }
    }
  }
}

const EMPTY_HASH = "0x" + "00".repeat(32);
const EMPTY_COINBASE = "0x" + "00".repeat(20);
