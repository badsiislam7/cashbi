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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
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
import { powHash, verifyHeaderPoW, difficultyToTarget } from "../consensus/pow.js";
import {
  DEV_CHAIN_ID,
  DEV_PARAM_VERSION,
  DIFFICULTY_RETARGET_INTERVAL,
  GENESIS_DIFFICULTY,
  POW_LIMIT,
} from "../config/params.js";
import { toHex } from "../util/bytes.js";

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_WORKERS = 64;
export const MAX_ATTEMPTS_PER_INVOCATION = 2 ** 31; // ~2.1e9 attempts per invocation cap

/** Monotonic counter for unique temporary file names (audit finding F-4). */
let tmpFileCounter = 0;

/** Unique temporary file path in the same directory as `path`. Combines pid,
    nanosecond time and a monotonic counter so concurrent/rapid writes never
    collide (audit finding F-4). */
function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${process.hrtime.bigint()}-${tmpFileCounter++}`;
}

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

/** Atomic write: temporary file + rename in the same directory (audit finding F-4).
    Uses a unique temporary name (pid + hrtime + monotonic counter) so rapid or
    concurrent writes never collide. Cleans up the temp file if write or rename
    fails so no partial file is left behind. */
export function writeCheckpointAtomic(path: string, cp: Checkpoint): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = tmpPathFor(path);
  try {
    writeFileSync(tmp, checkpointToJson(cp), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
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
    existing result. An identical existing artifact counts as already saved.
    On refusal due to different content, returns the existing parsed record so
    callers can reconcile (audit finding F-6). Uses unique temporary names and
    cleans up on write/rename failure (audit finding F-4). */
export function writeResultArtifact(
  path: string,
  record: CandidateRecord,
):
  | { ok: true; alreadyRecorded?: boolean }
  | { ok: false; reason: string; existing?: CandidateRecord } {
  const serialized = JSON.stringify(record, null, 2) + "\n";
  if (existsSync(path)) {
    let existing: string;
    try {
      existing = readFileSync(path, "utf8");
    } catch (err) {
      return { ok: false, reason: `existing result artifact unreadable: ${(err as Error).message}` };
    }
    if (existing === serialized) return { ok: true, alreadyRecorded: true };
    let existingRecord: CandidateRecord | undefined;
    try {
      existingRecord = JSON.parse(existing) as CandidateRecord;
    } catch {
      /* not parseable — existingRecord stays undefined */
    }
    return {
      ok: false,
      reason: `result artifact already exists at ${path} with different content — refusing to overwrite`,
      existing: existingRecord,
    };
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = tmpPathFor(path);
  try {
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
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
  /** Per-worker attempt budgets for THIS invocation (index = worker id).
      The sum of all budgets is the strict total attempt cap (audit finding F-2). */
  budgetsPerWorker: number[];
  /** Hash batch before yielding to the event loop (default 1024). */
  chunkYield?: number;
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

function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Runs one bounded mining session under an existing, VALIDATED checkpoint
 * using true multi-core parallelism via Node.js worker threads.
 *
 * Each logical worker runs in its own Worker thread and hashes a provably
 * disjoint lane of genesis nonces. The main thread is the sole coordinator:
 * it owns the checkpoint file, writes checkpoints atomically, verifies
 * candidates through the production `verifyHeaderPoW` + `blockHash`, and
 * enforces the strict global `--max-attempts` limit. Workers never write
 * files and never touch each other's lanes.
 *
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
  const checkpointEveryAttempts = options.checkpointEveryAttempts ?? 50_000;
  const cp = options.checkpoint as Checkpoint;
  const reportNonces = typeof options.onNonceProbe === "function";

  // Strict per-worker budgets (F-2): the sum equals the configured total cap,
  // so workers can never collectively exceed --max-attempts.
  const budgetsPerWorker = options.budgetsPerWorker;
  if (!Array.isArray(budgetsPerWorker) || budgetsPerWorker.length !== cp.workers.length) {
    throw new Error(
      `budgetsPerWorker must be an array of length ${cp.workers.length} (one per worker), got ${JSON.stringify(budgetsPerWorker)}`,
    );
  }
  for (const b of budgetsPerWorker) {
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1) {
      throw new Error(`budgetsPerWorker entries must be integers >= 1, got ${JSON.stringify(budgetsPerWorker)}`);
    }
  }

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
    workers: cp.workers.length,
    laneChunkSize: cp.plan.laneChunkSize,
  };
  const baselineTotal = cp.workers.reduce((acc, w) => acc + w.attempts, 0);
  const maxAttempts = budgetsPerWorker.reduce((sum, b) => sum + b, 0);

  // Per-worker state tracked by the main thread (single source of truth).
  // Workers report progress; the main thread merges it into the checkpoint.
  const workerStates = cp.workers.map((saved) => ({
    workerId: saved.worker,
    nextNonce: parseNonceStringOrThrow(saved.nextNonce),
    chunkIndex: saved.chunkIndex,
    attemptedHere: 0, // attempts made by this worker in THIS session
    baselineAttempts: saved.attempts,
    exhausted: saved.exhausted === true,
    done: false,
  }));

  const started = Date.now();
  let found: CandidateRecord | null = null;
  let stopped = false;
  let globalAttempts = 0;
  let lastCheckpointAttempts = 0;

  const persist = (finalCp: boolean): void => {
    cp.workers = workerStates.map((w) => ({
      worker: w.workerId,
      nextNonce: "0x" + w.nextNonce.toString(16),
      chunkIndex: w.chunkIndex,
      attempts: w.baselineAttempts + w.attemptedHere,
      exhausted: w.exhausted,
    }));
    cp.totalAttempts = cp.workers.reduce((sum, w) => sum + w.attempts, 0);
    cp.candidate = finalCp ? found : cp.candidate;
    cp.updatedAtUtc = utcNow();
    cp.checkpointCount += 1;
    writeCheckpointAtomic(options.checkpointPath, cp);
  };

  // F-5: If a result artifact exists but the checkpoint does not record a
  // candidate (crash between artifact write and checkpoint persist), reconcile
  // it through production validation before searching. A valid artifact is
  // adopted into the checkpoint; an invalid/stale/malformed one fails safely.
  if (cp.candidate === null) {
    const orphan = reconcileOrphanResultArtifact(options.plan, options.resultPath);
    if (orphan.status === "already-found") {
      cp.candidate = orphan.record;
      persist(true);
      return { status: "already-found", attempts: 0, candidate: cp.candidate, elapsedSeconds: 0, rate: 0 };
    }
  }

  // Session control: promise resolves exactly once when all workers finish,
  // a candidate is found/verified, or an error occurs.
  let sessionSettled = false;
  let sessionResolve: ((outcome: SessionOutcome) => void) | null = null;
  let sessionReject: ((err: Error) => void) | null = null;
  const sessionPromise = new Promise<SessionOutcome>((resolve, reject) => {
    sessionResolve = resolve;
    sessionReject = reject;
  });

  let workersDone = 0;
  const totalWorkers = cp.workers.length;
  const workerThreads: ChildProcess[] = [];

  const finishSession = (): SessionOutcome => {
    // Terminate all worker processes — session is complete.
    for (const w of workerThreads) {
      try {
        w.kill("SIGTERM");
      } catch {
        /* ignore termination errors */
      }
    }
    if (found === null) {
      persist(false);
    }
    const elapsedSeconds = Number(Date.now() - started) / 1000;
    const totalNow = cp.totalAttempts;
    // Determine status: budget exhaustion takes precedence over "stopped"
    // because both can be true when the global budget was reached.
    let st: SessionStatus;
    if (found !== null) {
      st = "candidate-found";
    } else if (globalAttempts >= maxAttempts) {
      st = "budget-exhausted";
    } else if (stopped) {
      st = "stopped";
    } else {
      st = "budget-exhausted";
    }
    return {
      status: st,
      attempts: totalNow - baselineTotal,
      candidate: found,
      elapsedSeconds,
      rate: elapsedSeconds > 0 ? (totalNow - baselineTotal) / elapsedSeconds : 0,
    };
  };

  const settleSession = (): void => {
    if (sessionSettled) return;
    sessionSettled = true;
    if (stopPollHandle) {
      clearImmediate(stopPollHandle);
      stopPollHandle = null;
    }
    const outcome = finishSession();
    if (sessionResolve) {
      sessionResolve(outcome);
      sessionResolve = null;
    }
    sessionReject = null;
  };

  const settleSessionError = (err: Error): void => {
    if (sessionSettled) return;
    sessionSettled = true;
    if (stopPollHandle) {
      clearImmediate(stopPollHandle);
      stopPollHandle = null;
    }
    // Terminate workers on error.
    for (const w of workerThreads) {
      try {
        w.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    if (sessionReject) {
      sessionReject(err);
      sessionReject = null;
    }
    sessionResolve = null;
  };

  const handleProgress = (
    workerId: number,
    nextNonce: string,
    attemptedHere: number,
    chunkIndex: number,
    exhausted: boolean,
    probedNonces: bigint[],
  ): void => {
    // Ignore messages after session is settled.
    if (sessionSettled) return;

    workersStarted = true;

    const state = workerStates[workerId];
    state.nextNonce = parseNonceStringOrThrow(nextNonce);
    state.chunkIndex = chunkIndex;
    state.attemptedHere = attemptedHere;
    state.exhausted = exhausted;
    const sessionAttempts = workerStates.reduce((sum, s) => sum + s.attemptedHere, 0);
    globalAttempts = baselineTotal + sessionAttempts;

    // Report probed nonces to the test hook (if any).
    if (reportNonces && options.onNonceProbe) {
      for (const n of probedNonces) options.onNonceProbe!(workerId, n);
    }

    // Check shouldStop — if the caller requests a stop, halt all workers.
    if (options.shouldStop?.() ?? false) {
      stopped = true;
      for (const w of workerThreads) w.send({ type: "stop" });
      settleSession();
    }

    // Periodic checkpoint on the attempt threshold (uses cumulative attempts
    // so checkpoint frequency is stable across resume).
    if (globalAttempts - lastCheckpointAttempts >= checkpointEveryAttempts) {
      persist(false);
      lastCheckpointAttempts = globalAttempts;
    }

    // Per-invocation budget reached — tell all workers to stop.
    // maxAttempts is the budget for THIS invocation only (not cumulative across
    // checkpoint history). Compare against session attempts, not globalAttempts.
    if (sessionAttempts >= maxAttempts && !stopped && !found) {
      stopped = true;
      for (const w of workerThreads) w.send({ type: "stop" });
    }

    options.onProgress?.({
      attempts: globalAttempts,
      workersBusy: exhausted ? 0 : 1,
      rate: 0,
      elapsedSeconds: Number(Date.now() - started) / 1000,
      checkpointCount: cp.checkpointCount,
    });
  };

  const handleCandidate = async (workerId: number, nonceHex: string): Promise<void> => {
    stopped = true;
    // Tell all workers to stop immediately.
    for (const w of workerThreads) w.send({ type: "stop" });

    const nonce = BigInt(nonceHex);
    const totalAttempts = baselineTotal + workerStates.reduce((sum, s) => sum + s.attemptedHere, 0) + 1;
    const verdict = verifyGenesisCandidate(options.plan, nonce, totalAttempts, utcNow());
    if (!verdict.ok || !verdict.record) {
      throw new Error(`in-tool verification rejected a target-passing nonce ${nonce.toString(16)}: ${verdict.reason}`);
    }
    found = verdict.record;
    const write = writeResultArtifact(options.resultPath, found);
    if (!write.ok) {
      // F-6: artifact exists with different content (another worker found a
      // competing candidate in the same batch). Verify the existing artifact
      // through production validation before deciding.
      const existing = write.existing;
      if (existing) {
        const existingNonce = BigInt(existing.nonce);
        const existingVerdict = verifyGenesisCandidate(
          options.plan,
          existingNonce,
          existing.totalAttempts,
          existing.foundAtUtc,
        );
        if (existingVerdict.ok && existingVerdict.record) {
          found = existingVerdict.record; // preserve the valid existing candidate
        } else {
          throw new Error(
            `competing candidate rejected: ${write.reason} (existing artifact failed production verification)`,
          );
        }
      } else {
        throw new Error(write.reason);
      }
    }
    persist(true);
    settleSession();
  };

  const handleDone = (workerId: number, attemptedHere: number, nextNonce: string, chunkIndex: number, exhausted: boolean): void => {
    if (sessionSettled) return;
    workerStates[workerId].done = true;
    workerStates[workerId].attemptedHere = attemptedHere;
    workerStates[workerId].nextNonce = parseNonceStringOrThrow(nextNonce);
    workerStates[workerId].chunkIndex = chunkIndex;
    workerStates[workerId].exhausted = exhausted;
    workersDone++;
    if (workersDone >= totalWorkers) {
      settleSession();
    }
  };

  const handleError = (workerId: number, message: string): void => {
    if (sessionSettled) return;
    workerStates[workerId].done = true;
    workersDone++;
    settleSessionError(new Error(`worker ${workerId} failed: ${message}`));
  };

  // Serialize bigint values as "0x"-prefixed hex strings for JSON transport
  // to the worker process via the MINING_WORKER_DATA environment variable.
  function serializeWorkerData(wd: {
    workerId: number;
    totalWorkers: number;
    laneChunkSize: number;
    startNonce: bigint;
    header: BlockHeader;
    budget: number;
    chunkYield: number;
    reportNonces: boolean;
    exhausted: boolean;
    startNonceOverride: bigint;
    chunkIndexOverride: number;
  }): string {
    return JSON.stringify({
      workerId: wd.workerId,
      totalWorkers: wd.totalWorkers,
      laneChunkSize: wd.laneChunkSize,
      startNonce: "0x" + wd.startNonce.toString(16),
      header: {
        parentHash: wd.header.parentHash,
        number: wd.header.number,
        timestamp: wd.header.timestamp,
        difficulty: "0x" + wd.header.difficulty.toString(16),
        coinbase: wd.header.coinbase,
        extraData: Buffer.from(wd.header.extraData).toString("hex"),
        gasLimit: "0x" + wd.header.gasLimit.toString(16),
        gasUsed: "0x" + wd.header.gasUsed.toString(16),
        transactionsRoot: wd.header.transactionsRoot,
        stateRoot: wd.header.stateRoot,
        nonce: "0x" + wd.header.nonce.toString(16),
      },
      budget: wd.budget,
      chunkYield: wd.chunkYield,
      reportNonces: wd.reportNonces,
      exhausted: wd.exhausted,
      startNonceOverride: "0x" + wd.startNonceOverride.toString(16),
      chunkIndexOverride: wd.chunkIndexOverride,
    });
  }

  // Check shouldStop before spawning any workers.
  if (options.shouldStop?.() ?? false) {
    return { status: "stopped", attempts: 0, candidate: null, elapsedSeconds: 0, rate: 0 };
  }
  const workerPath = new URL("./genesis-mining-worker.ts", import.meta.url).pathname;

  for (let w = 0; w < cp.workers.length; w++) {
    const state = workerStates[w];
    const child = fork(workerPath, [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        MINING_WORKER_DATA: serializeWorkerData({
          workerId: w,
          totalWorkers: cp.workers.length,
          laneChunkSize: cp.plan.laneChunkSize,
          startNonce: lanePlan.startNonce,
          header: options.plan.header,
          budget: budgetsPerWorker[w],
          chunkYield,
          reportNonces,
          exhausted: state.exhausted,
          startNonceOverride: state.nextNonce,
          chunkIndexOverride: state.chunkIndex,
        }),
      },
      serialization: "advanced",
    });
    workerThreads.push(child);

    child.on("message", (msg: { type: string; [key: string]: unknown }) => {
      switch (msg.type) {
        case "progress":
          handleProgress(
            msg.workerId as number,
            msg.nextNonce as string,
            msg.attemptedHere as number,
            msg.chunkIndex as number,
            msg.exhausted as boolean,
            reportNonces
              ? ((msg.probedNonces as string[]).map((h) => BigInt("0x" + h)))
              : [],
          );
          break;
        case "candidate":
          handleCandidate(msg.workerId as number, msg.nonce as string).catch((err: Error) => {
            settleSessionError(err);
          });
          break;
        case "done":
          handleDone(msg.workerId as number, msg.attempts as number, msg.nextNonce as string, msg.chunkIndex as number, msg.exhausted as boolean);
          break;
        case "error":
          handleError(msg.workerId as number, msg.message as string);
          break;
      }
    });

    child.on("error", (err: Error) => {
      handleError(w, err.message);
    });

    child.on("exit", (code: number) => {
      if (code !== 0 && !sessionSettled && !workerStates[w].done) {
        handleError(w, `worker exited with code ${code}`);
      }
    });
  }

  // SIGINT handler — signals all workers to stop, then lets them finish
  // their current batch and persist.
  let interrupted = false;
  const onSigInt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stdout.write("\nSIGINT received — finishing current batch, saving checkpoint, exiting…\n");
    stopped = true;
    for (const w of workerThreads) w.send({ type: "stop" });
  };
  process.on("SIGINT", onSigInt);

  // Timer-based shouldStop polling: workers can complete batches faster than
  // IPC round-trips, so we must check shouldStop independently of progress
  // messages. Uses setImmediate for the fastest possible polling on the main
  // thread event loop.
  let stopPollHandle: NodeJS.Immediate | null = null;
  let workersStarted = false;
  const startStopPoll = (): void => {
    const poll = (): void => {
      if (sessionSettled) return;
      // Only start checking shouldStop once workers have begun processing
      // (signaled by the first progress message). Before that, keep polling
      // so we don't miss the window.
      if (!workersStarted) {
        stopPollHandle = setImmediate(poll);
        return;
      }
      if (options.shouldStop?.() ?? false) {
        stopped = true;
        for (const w of workerThreads) w.send({ type: "stop" });
        settleSession();
        return;
      }
      stopPollHandle = setImmediate(poll);
    };
    stopPollHandle = setImmediate(poll);
  };
  startStopPoll();

  return sessionPromise;
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

/** Reconciles an orphaned result artifact: written but not yet recorded in
    the checkpoint (crash between artifact write and checkpoint persist, F-5).
    Validates the artifact through the production candidate-verification path.
    Returns the verified record if valid; throws if invalid, stale, malformed,
    or inconsistent — never silently accepts or overwrites unrelated files. */
export function reconcileOrphanResultArtifact(
  plan: GenesisToolPlan,
  resultPath: string,
): { status: "already-found"; record: CandidateRecord } | { status: "none" } {
  if (!existsSync(resultPath)) return { status: "none" };
  let raw: string;
  try {
    raw = readFileSync(resultPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read result artifact ${resultPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`malformed result artifact at ${resultPath} — refusing to silently accept or overwrite`);
  }
  const record = parsed as CandidateRecord;
  if (typeof record.nonce !== "string") {
    throw new Error(`orphan result artifact at ${resultPath} has no nonce field`);
  }
  const nonce = BigInt(record.nonce);
  const verdict = verifyGenesisCandidate(plan, nonce, record.totalAttempts, record.foundAtUtc);
  if (!verdict.ok || !verdict.record) {
    throw new Error(`orphan result artifact failed production re-verification: ${verdict.reason}`);
  }
  if (JSON.stringify(verdict.record) !== JSON.stringify(record)) {
    throw new Error(`orphan result artifact record differs from production re-derivation (nonce ${record.nonce})`);
  }
  return { status: "already-found", record: verdict.record };
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
    /** Attempts per worker between checkpoints (default 50_000). */
    checkpointEveryAttempts?: number;
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
  "checkpoint-every"?: string;
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
  const checkpointEveryAttempts = parseIntFlag(
    flags["checkpoint-every"],
    problems,
    "checkpoint-every",
    1,
    2 ** 31,
    false,
  );
  if (checkpointEveryAttempts !== null) values.checkpointEveryAttempts = checkpointEveryAttempts;

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
