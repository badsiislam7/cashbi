/**
 * Real CPU proof-of-work miner with:
 *  - EXPLICIT CONSENT GATE: mining refuses to start until the operator has
 *    granted consent (CLI flag or typed confirmation).
 *  - A resource limit: a configurable keccak/sec budget enforced by blocking
 *    micro-delays between hash batches, keeping the CPU footprint modest.
 *  - Cooperative stop for clean shutdown.
 *
 * This is real PoW (keccak hashing below a target), not a simulation; the
 * dev defaults simply make mining cheap. See UNRESOLVED_DECISIONS.md D-19.
 */
import type { Block, BlockHeader } from "../chain/block.js";
import type { Blockchain } from "../chain/blockchain.js";
import type { Mempool } from "../tx/mempool.js";
import { buildBlockForMining } from "./candidate.js";
import { sleep } from "../util/async.js";
import { utf8ToBytes } from "../util/bytes.js";
import { isMiningCandidate } from "../consensus/pow.js";
import { BLOCK_REWARD } from "../config/params.js";

export interface MinerOptions {
  /** Address credited with the coinbase reward. */
  coinbase: string;
  /** keccak/sec budget. 0 means unlimited (NOT recommended). */
  hashRatePerSecond: number;
  /** Extra header data. */
  extraData?: string;
  /** Callback for every successfully mined block. */
  onMinedBlock?: (block: Block) => void;
}

export interface MinerStatus {
  mining: boolean;
  consent: boolean;
  rounds: number;
  hashesTried: number;
  tipNumber: number;
}

export interface ConsentGrant {
  grantedAt: number;
  source: "cli-flag" | "interactive-prompt";
}

export class Miner {
  private consent: ConsentGrant | null = null;
  private running = false;
  private stopRequested = false;
  private rounds = 0;
  private hashesTried = 0;
  private worker: Promise<void> | null = null;
  private lastLoopError: string | null = null;

  constructor(
    private readonly chain: Blockchain,
    private readonly mempool: Mempool,
    private readonly options: MinerOptions,
  ) {}

  /** The ONLY way to enable mining: an explicit, recorded consent grant. */
  grantConsent(source: ConsentGrant["source"]): void {
    this.consent = { grantedAt: Date.now(), source };
  }

  status(): MinerStatus {
    return {
      mining: this.running,
      consent: this.consent !== null,
      rounds: this.rounds,
      hashesTried: this.hashesTried,
      tipNumber: this.chain.tip.number,
    };
  }

  lastError(): string | null {
    return this.lastLoopError;
  }

  /** Starts the mining loop; fail-closed without prior consent. */
  startMining(): void {
    if (this.consent === null) {
      throw new Error(
        "mining requires explicit consent: run `cashbi start --allow-mining` (or answer the interactive prompt). " +
        "CPU mining consumes compute resources; starting without user consent is unsupported.",
      );
    }
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.worker = this.mineLoop().catch((err) => {
      this.lastLoopError = (err as Error).message;
    }).finally(() => {
      this.running = false;
    });
  }

  stop(): void {
    this.stopRequested = true;
  }

  async closed(): Promise<void> {
    if (this.worker) await this.worker;
  }

  private async mineLoop(): Promise<void> {
    while (!this.stopRequested) {
      const candidate = buildBlockForMining({
        chain: this.chain,
        mempool: this.mempool,
        coinbase: this.options.coinbase,
        timestamp: Math.floor(Date.now() / 1000),
        activeReward: BLOCK_REWARD,
        extraData: utf8ToBytes(this.options.extraData ?? "cashbi"),
      });
      if (!candidate) {
        await sleep(250);
        continue;
      }
      const mined = await this.searchNonce(candidate);
      if (mined && !this.stopRequested) {
        this.rounds += 1;
        this.options.onMinedBlock?.(mined);
      }
      // Re-derive templates when the tip moved or tx set changed. Equal-stamp
      // consensus rules make a candidate template available every iteration,
      // so yield a real wall-clock slice here: without it the loop hot-spins,
      // stamping same-second blocks as fast as trivial difficulty allows and
      // starving the event loop. 250 ms keeps dev block production
      // wall-clock-sensible (the null-candidate path below already uses it).
      await sleep(250);
    }
  }

  private async searchNonce(candidate: Block): Promise<Block | null> {
    const header = candidate.header;
    const budget = this.options.hashRatePerSecond;
    const batch = budget > 0 ? Math.max(1, Math.min(64, Math.floor(budget / 32))) : 64;
    for (let base = 0n; !this.stopRequested; base += BigInt(batch)) {
      for (let offset = 0n; offset < BigInt(batch); offset++) {
        const nonce = base + offset;
        const withNonce: BlockHeader = { ...header, nonce };
        if (isMiningCandidate(withNonce, nonce)) {
          return { header: withNonce, transactions: candidate.transactions };
        }
      }
      this.hashesTried += batch;
      if (budget > 0) {
        // Yield cooperatively between batches so RPC, networking, timers and
        // shutdown stay responsive. sleep() hands control back to the event
        // loop instead of blocking it synchronously (delayMs used
        // Atomics.wait, which froze the whole thread).
        await sleep(1000 / budget);
      } else {
        // Unlimited budget: still yield once per batch to avoid starving the
        // event loop when no valid nonce is found quickly.
        await sleep(1);
      }
    }
    return null;
  }
}
