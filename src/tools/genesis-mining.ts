/**
 * Resumable genesis PoW mining utility (tool, NOT consensus).
 *
 * PURPOSE AND NON-GOALS
 * - Prepares and runs BOUNDED, checkpointed nonce searches over the genesis
 *   header preimage so an authorized operator can, over multiple stopped and
 *   resumed invocations, find a nonce with powHash <= POW_LIMIT.
 * - Reuses the production consensus functions exclusively: the per-nonce
 *   target check is `isMiningCandidate` from src/consensus/pow.ts and every
 *   discovered candidate is re-verified with the production `verifyHeaderPoW`
 *   and `blockHash` before anything is recorded. This file duplicates no
 *   consensus algorithm.
 * - This tool never pins a nonce in src/chain/genesis.ts, never activates
 *   startup genesis validation, and never changes DEV_PARAM_VERSION.
 * - Invoking anything without the full set of explicit arguments must not
 *   perform even one nonce attempt: `parseCliArguments` returns a mode the
 *   runner refuses to hash with unless `--mine` and all required arguments
 *   are present.
 *
 * LANE MODEL (checksummed resumability)
 * - The uint64 nonce space is partitioned into worker lanes: worker `w` owns
 *   every chunk `k` defined by the half-open range
 *       [start + (k*workers + w)*laneChunkSize, start + (k*workers + w + 1)*laneChunkSize)
 *   (inclusive end clamped to the maximum uint64). Lanes are mathematically
 *   disjoint and the k-th chunks of all workers together cover their interval
 *   contiguously.
 * - Each invocation gives every worker a fresh attempt budget starting at the
 *   worker's exact saved `nextNonce`; a worker first exhausts the remainder of
 *   its current chunk, then continues with later chunks of its own lane. This
 *   makes per-worker resume byte-exact (no completed work is reprocessed) and
 *   never gaps coverage.
 * - `laneChunkSize` is fixed when a checkpoint is first created and frozen in
 *   the checkpoint's plan block, so a later resume validates lane membership
 *   deterministically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildGenesis,
  emptyGenesisConfig,
  type GenesisConfig,
} from "../chain/genesis.js";
import {
  blockHash,
  hashHeaderWithoutNonce,
  type BlockHeader,
} from "../chain/block.js";
import {
  isMiningCandidate,
  powHash,
  verifyHeaderPoW,
  difficultyToTarget,
} from "../consensus/pow.js";
import {
  DEV_CHAIN_ID,
  DEV_PARAM_VERSION,
  DIFFICULTY_RETARGET_INTERVAL,
  GENESIS_DIFFICULTY,
  POW_LIMIT,
} from "../config/params.js";
import { toHex } from "../util/bytes.js";
import { sleep } from "../util/async.js";

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_WORKERS = 64;
export const MAX_ATTEMPTS_PER_INVOCATION = 2 ** 31; // ~2.1e9 attempts per invocation cap

export const CHECKPOINT_SCHEMA = "cashbi-genesis-mining-checkpoint";
export const CHECKPOINT_VERSION = 1;

export interface PlanSpec {
  /** First nonce of the whole plan (lane grid origin). */
  startNonce: bigint;
  workers: number;
  /** Per-lane chunk size: frozen at checkpoint creation, units = nonces. */
  laneChunkSize: number;
}

export interface WorkerWindow {
  worker: number;
  chunkIndex: number;
  /** Inclusive start of this chunk, <= MAX_UINT64 when size > 0. */
  fromNonce: bigint;
  /** Inclusive end of this chunk, clamped to MAX_UINT64. */
  toNonce: bigint;
  /** Number of nonces in the chunk (0 when the chunk lies past MAX_UINT64). */
  size: bigint;
}

export interface GenesisToolPlan {
  header: BlockHeader;
  /** keccak256(rlp(headerWithoutNonce)) of the pinned genesis preimage. */
  preimageDigest: string;
  config: GenesisConfig;
}

export interface WorkerSave {
  worker: number;
  nextNonce: string;
  /** The worker's OWN lane-chunk index (0, 1, 2, …) for `nextNonce`. */
  chunkIndex: number;
  attempts: number;
  /**
   * True when the worker consumed its lane up to (and including) the final
   * clamped chunk near MAX_UINT64. `nextNonce` then still points at the last
   * nonce of the final chunk (a uint64-invalid "skipped-to" position is not
   * representable); no further work is scheduled for this worker.
   */
  exhausted: boolean;
}

export interface CandidateRecord {
  nonce: string;
  nonceDecimal: string;
  preimageDigest: string;
  powHash: string;
  target: string;
  difficulty: string;
  powLimit: string;
  genesisHash: string;
  chainId: number;
  paramVersion: string;
  foundAtUtc: string;
  totalAttempts: number;
  header: {
    parentHash: string;
    number: number;
    timestamp: number;
    difficulty: string;
    coinbase: string;
    extraData: string;
    gasLimit: string;
    gasUsed: string;
    transactionsRoot: string;
    stateRoot: string;
  };
}

export interface Checkpoint {
  schema: string;
  version: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  genesis: {
    preimageDigest: string;
    chainId: number;
    difficulty: string;
    powLimit: string;
    targetBlockTimeSeconds: number;
    retargetInterval: number;
    paramVersion: string;
  };
  plan: { startNonce: string; workers: number; laneChunkSize: number };
  workers: WorkerSave[];
  totalAttempts: number;
  checkpointCount: number;
  candidate: CandidateRecord | null;
}

export interface CheckpointChecks {
  ok: boolean;
  problems: string[];
}

export const GENESIS_CHAIN_ID = DEV_CHAIN_ID;

/** Loads the genesis tool plan: exact pinned dev genesis header + preimage. */
export function getGenesisPlan(): GenesisToolPlan {
  const config = emptyGenesisConfig(0);
  const { block } = buildGenesis(config);
  return {
    header: block.header,
    preimageDigest: toHex(hashHeaderWithoutNonce(block.header)),
    config,
  };
}

/* ------------------------------------------------------------------ */
/* Lane allocation                                                     */
/* ------------------------------------------------------------------ */

/** Inclusive nonce window of worker `worker`, chunk `chunkIndex`. */
export function workerChunkStart(plan: PlanSpec, worker: number, chunkIndex: number): bigint {
  if (worker < 0 || worker >= plan.workers) throw new Error(`worker index ${worker} out of 0..${plan.workers - 1}`);
  if (chunkIndex < 0) throw new Error("chunkIndex must be >= 0");
  const offset = BigInt(chunkIndex) * BigInt(plan.workers) * BigInt(plan.laneChunkSize) + BigInt(worker * plan.laneChunkSize);
  return plan.startNonce + offset;
}

export function allocateWindow(plan: PlanSpec, worker: number, chunkIndex: number): WorkerWindow {
  const start = workerChunkStart(plan, worker, chunkIndex);
  if (start > MAX_UINT64) {
    return { worker, chunkIndex, fromNonce: MAX_UINT64, toNonce: MAX_UINT64, size: 0n };
  }
  const end = start + BigInt(plan.laneChunkSize) - 1n;
  const clamped = end > MAX_UINT64 ? MAX_UINT64 : end;
  return { worker, chunkIndex, fromNonce: start, toNonce: clamped, size: clamped - start + 1n };
}

/** All workers' windows for one chunk index (the per-invocation wave). */
export function allocateWindows(plan: PlanSpec, chunkIndex: number): WorkerWindow[] {
  const out: WorkerWindow[] = [];
  for (let w = 0; w < plan.workers; w++) out.push(allocateWindow(plan, w, chunkIndex));
  return out;
}

/* ------------------------------------------------------------------ */
/* Checkpoint construction / validation                                */
/* ------------------------------------------------------------------ */

export function buildFreshCheckpoint(plan: GenesisToolPlan, spec: PlanSpec, nowUtc: string): Checkpoint {
  if (spec.workers < 1 || spec.workers > MAX_WORKERS) throw new Error(`workers must be within 1..${MAX_WORKERS}`);
  if (!Number.isInteger(spec.laneChunkSize) || spec.laneChunkSize < 1) throw new Error("laneChunkSize must be an integer >= 1");
  if (spec.startNonce < 0n || spec.startNonce > MAX_UINT64) throw new Error("startNonce must be within uint64");
  return {
    schema: CHECKPOINT_SCHEMA,
    version: CHECKPOINT_VERSION,
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
    genesis: {
      preimageDigest: plan.preimageDigest,
      chainId: DEV_CHAIN_ID,
      difficulty: GENESIS_DIFFICULTY.toString(),
      powLimit: "0x" + POW_LIMIT.toString(16),
      targetBlockTimeSeconds: 600,
      retargetInterval: DIFFICULTY_RETARGET_INTERVAL,
      paramVersion: DEV_PARAM_VERSION,
    },
    plan: {
      startNonce: "0x" + spec.startNonce.toString(16),
      workers: spec.workers,
      laneChunkSize: spec.laneChunkSize,
    },
    workers: Array.from({ length: spec.workers }, (_, w) => ({
      worker: w,
      nextNonce: "0x" + allocateWindow(spec, w, 0).fromNonce.toString(16),
      chunkIndex: 0,
      attempts: 0,
      exhausted: false,
    })),
    totalAttempts: 0,
    checkpointCount: 0,
    candidate: null,
  };
}

interface ParsedLane {
  ok: boolean;
  /** Global chunk owner id: (rel / laneChunkSize) % workers. -1 when !ok. */
  lane: number;
  /** Worker's own lane-chunk index k such that the nonce lies in
      worker(lane)'s k-th chunk. -1 when !ok. */
  ownChunkIndex: number;
  offsetInChunk: bigint;
}

function laneMembership(plan: PlanSpec, nonce: bigint): ParsedLane {
  if (nonce < plan.startNonce) return { ok: false, lane: -1, ownChunkIndex: -1, offsetInChunk: 0n };
  if (nonce > MAX_UINT64) return { ok: false, lane: -1, ownChunkIndex: -1, offsetInChunk: 0n };
  const rel = nonce - plan.startNonce;
  const laneChunk = BigInt(plan.laneChunkSize);
  const globalChunk = rel / laneChunk;
  const lane = Number(globalChunk % BigInt(plan.workers));
  // Global chunk g = k*workers + lane  ⟹  own index k = (g - lane)/workers.
  const ownChunkIndex = Number((globalChunk - BigInt(lane)) / BigInt(plan.workers));
  return { ok: true, lane, ownChunkIndex, offsetInChunk: rel % laneChunk };
}

function tryParseNonce(value: unknown, problems: string[], label: string): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,16}$/.test(value)) {
    problems.push(`${label} is not a 0x-prefixed <=64-bit hex string: ${JSON.stringify(value)}`);
    return null;
  }
  // BigInt accepts any-length hex; no fromHex (which requires even length).
  return BigInt(value);
}

function tryParseNumber(value: unknown, problems: string[], label: string, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${label} is not an integer in [${min}, ${max}]: ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

function tryParseHexDigest(value: unknown, problems: string[], label: string): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    problems.push(`${label} is not a 32-byte hex digest: ${JSON.stringify(value)}`);
    return null;
  }
  return value;
}

/**
 * Full structural + semantic validation. Never repairs, never silently
 * resets: every detected problem is returned; callers must refuse to mine on
 * a non-empty problem list.
 */
export function validateCheckpoint(payload: unknown, plan: GenesisToolPlan): CheckpointChecks {
  const problems: string[] = [];
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, problems: ["checkpoint is not a JSON object"] };
  }
  const cp = payload as Record<string, unknown>;
  if (cp["schema"] !== CHECKPOINT_SCHEMA) {
    problems.push(`schema mismatch: expected ${JSON.stringify(CHECKPOINT_SCHEMA)}, found ${JSON.stringify(cp["schema"])}`);
  }
  const version = tryParseNumber(cp["version"], problems, "version", 0, 1 << 30);
  if (version !== null && version !== CHECKPOINT_VERSION) {
    problems.push(`unsupported checkpoint version ${version} (this build supports ${CHECKPOINT_VERSION})`);
  }
  // Genesis identity block.
  const genesis = cp["genesis"];
  if (typeof genesis !== "object" || genesis === null) {
    problems.push("genesis block is not an object");
  } else {
    const g = genesis as Record<string, unknown>;
    const digest = tryParseHexDigest(g["preimageDigest"], problems, "genesis.preimageDigest");
    if (digest !== null && digest !== plan.preimageDigest) {
      problems.push(
        `checkpoint preimage digest ${digest} does not match the current genesis preimage ${plan.preimageDigest} ` +
        "(stale checkpoint from a different genesis configuration)",
      );
    }
    const chainId = tryParseNumber(g["chainId"], problems, "genesis.chainId", 0, 2 ** 31);
    if (chainId !== null && chainId !== DEV_CHAIN_ID) {
      problems.push(`checkpoint chainId ${chainId} does not match DEV_CHAIN_ID ${DEV_CHAIN_ID}`);
    }
    if (g["powLimit"] !== "0x" + POW_LIMIT.toString(16)) {
      problems.push(`checkpoint powLimit ${JSON.stringify(g["powLimit"])} does not match the consensus POW_LIMIT`);
    }
    if (g["difficulty"] !== GENESIS_DIFFICULTY.toString()) {
      problems.push(`checkpoint genesis difficulty ${JSON.stringify(g["difficulty"])} does not match GENESIS_DIFFICULTY`);
    }
    for (const key of ["targetBlockTimeSeconds", "retargetInterval"] as const) {
      const n = tryParseNumber(g[key], problems, `genesis.${key}`, 1, 2 ** 31);
      if (n !== null && key === "targetBlockTimeSeconds" && n !== 600) {
        problems.push(`checkpoint targetBlockTimeSeconds ${n} does not match the consensus value 600`);
      }
      if (n !== null && key === "retargetInterval" && n !== DIFFICULTY_RETARGET_INTERVAL) {
        problems.push(`checkpoint retargetInterval ${n} does not match the consensus value ${DIFFICULTY_RETARGET_INTERVAL}`);
      }
    }
    if (g["paramVersion"] !== DEV_PARAM_VERSION) {
      problems.push(`checkpoint paramVersion ${JSON.stringify(g["paramVersion"])} does not match DEV_PARAM_VERSION ${DEV_PARAM_VERSION}`);
    }
  }
  // Plan block.
  if (typeof cp["plan"] !== "object" || cp["plan"] === null) {
    problems.push("plan block is not an object");
    return { ok: false, problems };
  }
  const p = cp["plan"] as Record<string, unknown>;
  const startNonce = tryParseNonce(p["startNonce"], problems, "plan.startNonce");
  const workers = tryParseNumber(p["workers"], problems, "plan.workers", 1, MAX_WORKERS);
  const laneChunkSize = tryParseNumber(p["lanes" in p ? "lanes" : "laneChunkSize"], problems, "plan.laneChunkSize", 1, 2 ** 31);
  if (startNonce === null || workers === null || laneChunkSize === null) {
    return { ok: false, problems };
  }
  const spec: PlanSpec = { startNonce, workers, laneChunkSize };

  // Worker state.
  if (!Array.isArray(cp["workers"])) {
    problems.push("workers is not an array");
    return { ok: false, problems };
  }
  const workersArr = cp["workers"] as unknown[];
  if (workersArr.length !== workers) {
    problems.push(`workers array length ${workersArr.length} != plan.workers ${workers}`);
    return { ok: false, problems };
  }
  const seen = new Set<number>();
  let attemptsSum = 0;
  const parsedWorkers: WorkerSave[] = [];
  for (const raw of workersArr) {
    if (typeof raw !== "object" || raw === null) {
      problems.push("worker entry is not an object");
      return { ok: false, problems };
    }
    const w = raw as Record<string, unknown>;
    const workerId = tryParseNumber(w["worker"], problems, "worker.worker", 0, MAX_WORKERS);
    if (workerId === null) return { ok: false, problems };
    if (workerId >= workers) {
      problems.push(`worker id ${workerId} >= plan.workers ${workers}`);
      return { ok: false, problems };
    }
    if (seen.has(workerId)) {
      problems.push(`duplicate worker id ${workerId}`);
      return { ok: false, problems };
    }
    seen.add(workerId);
    const nextNonce = tryParseNonce(w["nextNonce"], problems, `worker ${workerId}.nextNonce`);
    const chunkIndex = tryParseNumber(w["chunkIndex"], problems, `worker ${workerId}.chunkIndex`, 0, 2 ** 31);
    const attempts = tryParseNumber(w["attempts"], problems, `worker ${workerId}.attempts`, 0, 2 ** 53);
    let exhausted = false;
    if (w["exhausted"] !== undefined) {
      if (w["exhausted"] !== true && w["exhausted"] !== false) {
        problems.push(`worker ${workerId}.exhausted must be a boolean, got ${JSON.stringify(w["exhausted"])}`);
        return { ok: false, problems };
      }
      exhausted = w["exhausted"] === true;
    }
    if (nextNonce === null || chunkIndex === null || attempts === null) {
      return { ok: false, problems };
    }
    if (exhausted) {
      // Done worker: nextNonce must be the LAST nonce of the recorded own chunk.
      const finalWindow = allocateWindow(spec, workerId, chunkIndex);
      if (finalWindow.size === 0n || nextNonce !== finalWindow.toNonce) {
        problems.push(
          `worker ${workerId} is marked exhausted but nextNonce ${nextNonce.toString(16)} is not the final ` +
          `nonce 0x${finalWindow.toNonce.toString(16)} of its recorded chunk ${chunkIndex}`,
        );
        return { ok: false, problems };
      }
    } else {
      // Lane membership: nextNonce must be inside worker's own lane.
      const lane = laneMembership(spec, nextNonce);
      if (!lane.ok || lane.lane !== workerId) {
        problems.push(
          `worker ${workerId}.nextNonce ${nextNonce.toString(16)} is not inside worker ${workerId}'s lane ` +
          `(lane ${lane.ok ? lane.lane : "out-of-range"}; disjoint lanes would be violated)`,
        );
        return { ok: false, problems };
      }
      if (lane.ownChunkIndex < chunkIndex) {
        problems.push(`worker ${workerId}: chunkIndex ${chunkIndex} ahead of nextNonce's own chunk ${lane.ownChunkIndex}`);
        return { ok: false, problems };
      }
      // Overlap guard: the recorded chunk window must still contain nextNonce.
      const window = allocateWindow(spec, workerId, chunkIndex);
      if (window.size === 0n || nextNonce > window.toNonce || nextNonce < window.fromNonce) {
        problems.push(`worker ${workerId}.nextNonce ${nextNonce.toString(16)} lies outside its chunk window`);
        return { ok: false, problems };
      }
    }
    attemptsSum += attempts;
    parsedWorkers.push({
      worker: workerId,
      nextNonce: "0x" + nextNonce.toString(16),
      chunkIndex,
      attempts,
      exhausted,
    });
  }
  // Sum integrity: totalAttempts equals the sum of worker attempts.
  const totalAttempts = tryParseNumber(cp["totalAttempts"], problems, "totalAttempts", 0, 2 ** 53);
  if (totalAttempts !== null && totalAttempts !== attemptsSum) {
    problems.push(`totalAttempts ${totalAttempts} != sum of worker attempts ${attemptsSum}`);
  }
  // Candidate (if present) is structurally validated here; cryptographic
  // re-verification happens in reverifyCandidate at resume time.
  if (cp["candidate"] !== null && cp["candidate"] !== undefined) {
    const c = cp["candidate"] as Record<string, unknown>;
    tryParseNonce(c["nonce"], problems, "candidate.nonce");
    tryParseHexDigest(c["preimageDigest"], problems, "candidate.preimageDigest");
    tryParseHexDigest(c["powHash"], problems, "candidate.powHash");
    tryParseHexDigest(c["genesisHash"], problems, "candidate.genesisHash");
    tryParseHexDigest(c["target"], problems, "candidate.target");
  }

  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ */
/* Atomic file IO                                                      */
/* ------------------------------------------------------------------ */

export function checkpointToJson(cp: Checkpoint): string {
  return JSON.stringify(cp, null, 2) + "\n";
}

/** Atomic write: temporary file + rename in the same directory. */
export function writeCheckpointAtomic(path: string, cp: Checkpoint): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, checkpointToJson(cp), "utf8");
  renameSync(tmp, path);
}

export interface LoadedCheckpoint {
  ok: boolean;
  reason?: string;
  checks?: CheckpointChecks;
  checkpoint?: Checkpoint;
}

export function loadCheckpoint(
  path: string,
  plan: GenesisToolPlan,
): LoadedCheckpoint {
  if (!existsSync(path)) return { ok: false, reason: `checkpoint file does not exist: ${path}` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read checkpoint ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: `malformed checkpoint JSON at ${path} — refusing to silent-reset; ` +
      "an operator must consciously move or delete this file",
    };
  }
  const checks = validateCheckpoint(parsed, plan);
  if (!checks.ok) {
    return {
      ok: false,
      reason: `invalid checkpoint at ${path}:
  - ${checks.problems.join("\n  - ")}
Refusing to resume and refusing to reset — an operator must consciously move or delete this file.`,
      checks,
    };
  }
  return { ok: true, checkpoint: parsed as Checkpoint, checks };
}

/* ------------------------------------------------------------------ */
/* Candidate verification and result artifact                          */
/* ------------------------------------------------------------------ */

export interface CandidateVerdict {
  ok: boolean;
  reason?: string;
  record?: CandidateRecord;
}

/**
 * Turns a raw target-passing candidate into a fully re-verified record:
 * 1. re-runs the production validator `verifyHeaderPoW`,
 * 2. re-derives the post-mining genesis hash with the production `blockHash`,
 * 3. cross-checks the preimage digest recorded in the plan,
 * 4. re-computes the powHash with the production function for the record.
 * Untrusted until all checks pass — on any inconsistency, no record is built.
 */
export function verifyGenesisCandidate(
  plan: GenesisToolPlan,
  nonce: bigint,
  totalAttempts: number,
  nowUtc: string,
): CandidateVerdict {
  const header = plan.header; // nonce is excluded from the preimage; safe to set
  header.nonce = nonce & MAX_UINT64;
  const pow = verifyHeaderPoW(header, { nonce: header.nonce });
  if (!pow.ok) {
    return { ok: false, reason: `production verifyHeaderPoW rejected the candidate: ${pow.reason}` };
  }
  const digest = toHex(hashHeaderWithoutNonce(header));
  if (digest !== plan.preimageDigest) {
    return { ok: false, reason: `preimage drifted: ${digest} != ${plan.preimageDigest}` };
  }
  return {
    ok: true,
    record: {
      nonce: "0x" + header.nonce.toString(16).padStart(16, "0"),
      nonceDecimal: header.nonce.toString(10),
      preimageDigest: plan.preimageDigest,
      powHash: toHex(powHash(header, header.nonce)),
      target: "0x" + difficultyToTarget(header.difficulty).toString(16),
      difficulty: header.difficulty.toString(),
      powLimit: "0x" + POW_LIMIT.toString(16),
      genesisHash: blockHash(header),
      chainId: DEV_CHAIN_ID,
      paramVersion: DEV_PARAM_VERSION,
      foundAtUtc: nowUtc,
      totalAttempts,
      header: {
        parentHash: header.parentHash,
        number: header.number,
        timestamp: header.timestamp,
        difficulty: header.difficulty.toString(),
        coinbase: header.coinbase,
        extraData: toHex(header.extraData),
        gasLimit: header.gasLimit.toString(),
        gasUsed: header.gasUsed.toString(),
        transactionsRoot: header.transactionsRoot,
        stateRoot: header.stateRoot,
      },
    },
  };
}

/** Writes the result artifact atomically; refuses to overwrite a different
    existing result. An identical existing artifact counts as already saved. */
export function writeResultArtifact(
  path: string,
  record: CandidateRecord,
): { ok: true; alreadyRecorded?: boolean } | { ok: false; reason: string } {
  const serialized = JSON.stringify(record, null, 2) + "\n";
  if (existsSync(path)) {
    let existing: string;
    try {
      existing = readFileSync(path, "utf8");
    } catch (err) {
      return { ok: false, reason: `existing result artifact unreadable: ${(err as Error).message}` };
    }
    if (existing === serialized) return { ok: true, alreadyRecorded: true };
    return {
      ok: false,
      reason: `result artifact already exists at ${path} with different content — refusing to overwrite`,
    };
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, serialized, "utf8");
  renameSync(tmp, path);
  return { ok: true };
}
/* ------------------------------------------------------------------ */
/* Mining session runner                                               */
/* ------------------------------------------------------------------ */

export interface SessionOptions {
  plan: GenesisToolPlan;
  checkpointPath: string;
  resultPath: string;
  /** Validated, resumed checkpoint snapshot (SRC of truth for the session). */
  checkpoint: Checkpoint;
  /** Per-worker attempt budget for THIS invocation (must be >= 1). */
  budgetPerWorker: number;
  /** Hash batch before yielding to the event loop (default 1024). */
  chunkYield?: number;
  /** Cooperative sleep after each batch in ms (default 1). */
  sleepMs?: number;
  /** Test-only observation hook: no effect on the search result. */
  onNonceProbe?: (worker: number, nonce: bigint) => void;
  onProgress?: (info: ProgressInfo) => void;
  /** Checked between batches; set true for graceful Ctrl+C. */
  shouldStop?: () => boolean;
  /** Checkpoint after this many further attempts per worker (default 50_000). */
  checkpointEveryAttempts?: number;
}

export interface ProgressInfo {
  attempts: number;
  workersBusy: number;
  rate: number;
  elapsedSeconds: number;
  checkpointCount: number;
}

export type SessionStatus = "budget-exhausted" | "candidate-found" | "stopped" | "already-found";

export interface SessionOutcome {
  status: SessionStatus;
  attempts: number;
  candidate: CandidateRecord | null;
  elapsedSeconds: number;
  rate: number;
}

interface WorkerLive {
  saved: WorkerSave;         // frozen original from the checkpoint (baseline)
  nextNonce: bigint;         // live position in worker's own lane
  chunkIndex: number;        // live OWN chunk index (worker's k-th lane chunk)
  attemptedHere: number;     // attempts made during THIS session
  exhausted: boolean;        // lane fully consumed (final chunk past MAX_UINT64)
}

function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Runs one bounded mining session under an existing, VALIDATED checkpoint.
 * - Every worker continues at its exact saved nonce: no completed attempt is
 *   reprocessed, no other worker's lane is touched.
 * - Progress is merged into the checkpoint (baseline attempts + this
 *   session's delta) and written atomically at every checkpoint point, so an
 *   interruption loses at most the currently executing batch.
 * - A target-passing nonce is treated as UNTRUSTED: the search halts, and the
 *   production `verifyHeaderPoW` + `blockHash` must re-derive the record
 *   before either the checkpoint candidate field or the result artifact are
 *   written.
 */
export async function runMiningSession(options: SessionOptions): Promise<SessionOutcome> {
  const chunkYield = options.chunkYield ?? 1024;
  const sleepMs = options.sleepMs ?? 1;
  const checkpointEveryAttempts = options.checkpointEveryAttempts ?? 50_000;
  const cp = options.checkpoint as Checkpoint;

  // A candidate already recorded in the checkpoint is re-verified through the
  // production validator (never trusted blindly) before anything else.
  const existing = reverifyRecordedCandidateIfAny(options.plan, cp);
  if (!existing.ok) {
    throw new Error(`checkpoint candidate failed re-verification: ${existing.reason}`);
  }
  if (cp.candidate !== null) {
    return { status: "already-found", attempts: 0, candidate: cp.candidate, elapsedSeconds: 0, rate: 0 };
  }

  const lanePlan: PlanSpec = {
    startNonce: parseNonceStringOrThrow(cp.plan.startNonce),
    workers: cp.plan.workers,
    laneChunkSize: cp.plan.laneChunkSize,
  };
  const baselineTotal = cp.workers.reduce((acc, w) => acc + w.attempts, 0);
  const live: WorkerLive[] = cp.workers.map((saved) => ({
    saved: { ...saved },
    nextNonce: parseNonceStringOrThrow(saved.nextNonce),
    chunkIndex: saved.chunkIndex,
    attemptedHere: 0,
    exhausted: saved.exhausted === true,
  }));

  const started = Date.now();
  let found: CandidateRecord | null = null;
  let stopped = false;

  const persist = (finalCp: boolean): void => {
    cp.workers = live.map((w) => ({
      ...w.saved,
      nextNonce: "0x" + w.nextNonce.toString(16),
      chunkIndex: w.chunkIndex,
      attempts: w.saved.attempts + w.attemptedHere,
      exhausted: w.exhausted,
    }));
    cp.totalAttempts = cp.workers.reduce((sum, w) => sum + w.attempts, 0);
    cp.candidate = finalCp ? found : cp.candidate;
    cp.updatedAtUtc = utcNow();
    cp.checkpointCount += 1;
    writeCheckpointAtomic(options.checkpointPath, cp);
  };

  /** Candidate handling: re-derive everything, write the result artifact
   *  first (the authoritative record), then the checkpoint. */
  const handleCandidate = (nonce: bigint): void => {
    const totalAttempts = baselineTotal + live.reduce((acc, w) => acc + w.attemptedHere, 0) + 1;
    const verdict = verifyGenesisCandidate(options.plan, nonce, totalAttempts, utcNow());
    if (!verdict.ok || !verdict.record) {
      throw new Error(`in-tool verification rejected a target-passing nonce ${nonce.toString(16)}: ${verdict.reason}`);
    }
    found = verdict.record;
    const write = writeResultArtifact(options.resultPath, found);
    if (!write.ok) throw new Error(write.reason);
    persist(true);
  };

  const runOne = async (w: WorkerLive): Promise<void> => {
    let attemptedSinceCheckpoint = 0;
    const advanceOrFinish = (): boolean => {
      /** When `w.nextNonce` has left the current own chunk, jump to the start
       *  of the NEXT own-lane chunk; set `exhausted` when none exists. */
      const nextWindow = allocateWindow(lanePlan, w.saved.worker, w.chunkIndex + 1);
      if (nextWindow.size === 0n) {
        w.exhausted = true;
        // Keep nextNonce a valid uint64: pin it to the final nonce of the
        // chunk just completed (the worker's last nonce in this lane).
        const done = allocateWindow(lanePlan, w.saved.worker, w.chunkIndex);
        w.nextNonce = done.toNonce;
        return false; // lane fully consumed: no further work
      }
      w.nextNonce = nextWindow.fromNonce;
      w.chunkIndex = w.chunkIndex + 1;
      return true;
    };
    while (w.attemptedHere < options.budgetPerWorker && found === null && !stopped) {
      if (w.exhausted) break; // nothing left in this worker's lane
      // Validate lane membership from live state.
      const membership = laneMembership(lanePlan, w.nextNonce);
      if (!membership.ok || membership.lane !== w.saved.worker || membership.ownChunkIndex < w.chunkIndex) {
        throw new Error(
          `worker ${w.saved.worker}: live position ${w.nextNonce.toString(16)} left its lane (checkpoint inconsistency)`,
        );
      }
      w.chunkIndex = membership.ownChunkIndex;
      const window = allocateWindow(lanePlan, w.saved.worker, w.chunkIndex);
      if (window.size === 0n) {
        if (!advanceOrFinish()) break;
        continue;
      }
      if (w.nextNonce > window.toNonce) {
        // Current own chunk complete; jump within the worker's own lane.
        if (!advanceOrFinish()) break;
        continue;
      }

      const batchBudget = Math.min(chunkYield, options.budgetPerWorker - w.attemptedHere);
      const batchEnd = w.nextNonce + BigInt(batchBudget) - 1n > window.toNonce
        ? window.toNonce
        : w.nextNonce + BigInt(batchBudget) - 1n;
      let nonce = w.nextNonce;
      while (nonce <= batchEnd) {
        options.onNonceProbe?.(w.saved.worker, nonce);
        if (isMiningCandidate(options.plan.header, nonce)) {
          handleCandidate(nonce);
          return;
        }
        nonce += 1n;
        w.nextNonce = nonce;
        w.attemptedHere += 1;
        attemptedSinceCheckpoint += 1;
      }
      if (w.nextNonce > window.toNonce && !advanceOrFinish()) {
        // The chunk that just finished was the worker's last one.
        attemptedSinceCheckpoint = Number.MAX_SAFE_INTEGER; // force final persist
      }
      // Checkpoint on the attempt-threshold or when the worker becomes idle.
      const budgetLeft = options.budgetPerWorker - w.attemptedHere;
      const laneDone = window.toNonce < w.nextNonce;
      if (attemptedSinceCheckpoint >= checkpointEveryAttempts || budgetLeft === 0 || laneDone) {
        persist(false);
        attemptedSinceCheckpoint = 0;
        options.onProgress?.({
          attempts: baselineTotal + live.reduce((acc, x) => acc + x.attemptedHere, 0),
          workersBusy: window.size === 0n ? 0 : 1,
          rate: 0,
          elapsedSeconds: Number(Date.now() - started) / 1000,
          checkpointCount: cp.checkpointCount,
        });
      }
      if (sleepMs > 0) await sleep(sleepMs);
      if (options.shouldStop?.() ?? false) stopped = true;
    }
  };

  await Promise.all(live.map((w) => runOne(w)));

  const status: SessionStatus = found !== null
    ? "candidate-found"
    : stopped ? "stopped" : "budget-exhausted";
  if (status !== "candidate-found") persist(false); // candidate path already persisted with the record
  const elapsedSeconds = Number(Date.now() - started) / 1000;
  const totalNow = cp.totalAttempts;
  return {
    status,
    attempts: totalNow - baselineTotal,
    candidate: found,
    elapsedSeconds,
    rate: elapsedSeconds > 0 ? (totalNow - baselineTotal) / elapsedSeconds : 0,
  };
}

/** Re-verifies an existing checkpoint candidate through the production
 *  validator; never trusts the stored fields blindly. */
export function reverifyRecordedCandidateIfAny(
  plan: GenesisToolPlan,
  cp: Checkpoint,
): { ok: boolean; reason?: string; record?: CandidateRecord } {
  if (!cp.candidate) return { ok: true };
  const nonce = BigInt(cp.candidate.nonce);
  const record = verifyGenesisCandidate(plan, nonce, cp.candidate.totalAttempts, cp.candidate.foundAtUtc);
  if (!record.ok || !record.record) return { ok: false, reason: record.reason };
  if (JSON.stringify(record.record) !== JSON.stringify(cp.candidate)) {
    return {
      ok: false,
      reason: `re-derived candidate record differs from the stored one (nonce ${cp.candidate.nonce})`,
    };
  }
  return { ok: true, record: record.record };
}

/* ------------------------------------------------------------------ */
/* Shared CLI parsing (imported by scripts/mine-genesis.ts so that the
   safe-exit guarantees run without spawning processes in tests)        */
/* ------------------------------------------------------------------ */

export interface ParsedCli {
  mode: "usage" | "plan" | "mine";
  problems: string[];
  values: {
    mine: boolean;
    startNonce?: bigint;
    maxAttempts?: number;
    workers?: number;
    checkpoint?: string;
    result?: string;
    chunkYield?: number;
    sleepMs?: number;
  };
}

export interface CliFlags {
  mine?: boolean;
  start?: string;
  "max-attempts"?: string;
  workers?: string;
  checkpoint?: string;
  result?: string;
  "chunk-size"?: string;
  "sleep-ms"?: string;
}

function parseIntFlag(
  value: string | undefined,
  problems: string[],
  label: string,
  min: number,
  max: number,
  required = true,
): number | null {
  if (value === undefined) {
    if (required) problems.push(`missing required argument --${label}`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`--${label} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
    return null;
  }
  return n;
}

/**
 * Central CLI gate: a nonce search happens ONLY when every required argument
 * is present AND `--mine` is passed. Without `--mine` this never authorizes
 * hashing — even with complete arguments it produces a plan preview only.
 */
export function parseCliArguments(flags: CliFlags): ParsedCli {
  const problems: string[] = [];
  const values: ParsedCli["values"] = { mine: flags.mine === true };
  let startNonce: bigint | null = null;
  if (flags.start === undefined) {
    problems.push("missing required argument --start (e.g. --start 0x0)");
  } else {
    const s = flags.start.trim();
    const parsed = /^0x[0-9a-f]+$/.test(s) || /^\d+$/.test(s) ? BigInt(s) : null;
    if (parsed === null) problems.push(`--start must be 0x-hex or decimal, got ${JSON.stringify(flags.start)}`);
    else if (parsed < 0n || parsed > MAX_UINT64) {
      problems.push(`--start must be within uint64 (0..${MAX_UINT64.toString(16)}), got ${s}`);
    } else startNonce = parsed;
  }
  values.startNonce = startNonce ?? undefined;
  const maxAttempts = parseIntFlag(flags["max-attempts"], problems, "max-attempts", 1, MAX_ATTEMPTS_PER_INVOCATION);
  values.maxAttempts = maxAttempts ?? undefined;
  const workers = parseIntFlag(flags.workers, problems, "workers", 1, MAX_WORKERS);
  values.workers = workers ?? undefined;
  if (typeof flags.checkpoint !== "string" || flags.checkpoint.length === 0) {
    problems.push("missing required argument --checkpoint <path>");
  } else {
    values.checkpoint = flags.checkpoint;
  }
  if (typeof flags.result === "string" && flags.result.length > 0) values.result = flags.result;
  const chunkYield = parseIntFlag(flags["chunk-size"], problems, "chunk-size", 1, 2 ** 24, false);
  if (chunkYield !== null) values.chunkYield = chunkYield;
  const sleepMs = parseIntFlag(flags["sleep-ms"], problems, "sleep-ms", 0, 3_600_000, false);
  if (sleepMs !== null) values.sleepMs = sleepMs;

  if (problems.length !== 0) return { mode: "usage", problems, values };
  if (!values.mine) return { mode: "plan", problems: [], values };
  return { mode: "mine", problems: [], values };
}

function parseNonceStringOrThrow(hex: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-f]{1,16}$/.test(hex)) {
    throw new Error(`invalid nonce string ${JSON.stringify(hex)}`);
  }
  return BigInt(hex);
}
