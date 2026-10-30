#!/usr/bin/env tsx
/**
 * CashBI Genesis PoW mining worker process entry point.
 *
 * Runs as a separate Node.js process (spawned by the main thread via
 * child_process.fork), hashing a disjoint lane of genesis nonces and reporting
 * progress/candidates to the main process via IPC (process.send).
 * Never writes files directly — all checkpoint and result writes are
 * coordinated by the main thread (src/tools/genesis-mining.ts).
 *
 * The worker imports only the production PoW function it needs
 * (`isMiningCandidate`). It never touches checkpoint files, result
 * artifacts, or genesis configuration files directly.
 *
 * Worker init data is passed via the MINING_WORKER_DATA environment variable
 * as JSON. BigInt values are serialized as "0x"-prefixed hex strings and
 * parsed back here.
 */
import { isMiningCandidate } from "../consensus/pow.js";
import type { BlockHeader } from "../chain/block.js";

export const MAX_UINT64 = (1n << 64n) - 1n;

/** Parse a "0x"-prefixed hex string (or decimal) into a bigint. */
function parseBigInt(value: string): bigint {
  if (value.startsWith("0x") || value.startsWith("0X")) return BigInt(value);
  return BigInt(value);
}

interface WorkerWindow {
  worker: number;
  chunkIndex: number;
  fromNonce: bigint;
  toNonce: bigint;
  size: bigint;
}

interface WorkerProgressMsg {
  type: "progress";
  workerId: number;
  nextNonce: string;
  attemptedHere: number;
  chunkIndex: number;
  exhausted: boolean;
  probedNonces: string[]; // hex nonces probed in this batch (without 0x prefix)
}

interface WorkerCandidateMsg {
  type: "candidate";
  workerId: number;
  nonce: string; // 0x-prefixed padded hex
}

interface WorkerDoneMsg {
  type: "done";
  workerId: number;
  attempts: number;
  nextNonce: string;
  chunkIndex: number;
  exhausted: boolean;
}

interface WorkerErrorMsg {
  type: "error";
  workerId: number;
  message: string;
}

type WorkerToMainMsg = WorkerProgressMsg | WorkerCandidateMsg | WorkerDoneMsg | WorkerErrorMsg;

interface MainToWorkerMsg {
  type: "stop";
}

/** Inclusive nonce window of worker `worker`, chunk `chunkIndex`. */
function workerChunkStart(
  plan: { startNonce: bigint; workers: number; laneChunkSize: number },
  worker: number,
  chunkIndex: number,
): bigint {
  const offset =
    BigInt(chunkIndex) * BigInt(plan.workers) * BigInt(plan.laneChunkSize) +
    BigInt(worker * plan.laneChunkSize);
  return plan.startNonce + offset;
}

function allocateWindow(
  plan: { startNonce: bigint; workers: number; laneChunkSize: number },
  worker: number,
  chunkIndex: number,
): WorkerWindow {
  const start = workerChunkStart(plan, worker, chunkIndex);
  if (start > MAX_UINT64) {
    return { worker, chunkIndex, fromNonce: MAX_UINT64, toNonce: MAX_UINT64, size: 0n };
  }
  const end = start + BigInt(plan.laneChunkSize) - 1n;
  const clamped = end > MAX_UINT64 ? MAX_UINT64 : end;
  return { worker, chunkIndex, fromNonce: start, toNonce: clamped, size: clamped - start + 1n };
}

/** Map a nonce to its owning worker's lane and own-chunk index. */
function laneMembership(
  plan: { startNonce: bigint; workers: number; laneChunkSize: number },
  nonce: bigint,
): { ok: boolean; lane: number; ownChunkIndex: number; offsetInChunk: bigint } {
  if (nonce < plan.startNonce) return { ok: false, lane: -1, ownChunkIndex: -1, offsetInChunk: 0n };
  if (nonce > MAX_UINT64) return { ok: false, lane: -1, ownChunkIndex: -1, offsetInChunk: 0n };
  const rel = nonce - plan.startNonce;
  const laneChunk = BigInt(plan.laneChunkSize);
  const globalChunk = rel / laneChunk;
  const lane = Number(globalChunk % BigInt(plan.workers));
  const ownChunkIndex = Number((globalChunk - BigInt(lane)) / BigInt(plan.workers));
  return { ok: true, lane, ownChunkIndex, offsetInChunk: rel % laneChunk };
}

/** Advance to the start of the next own-lane chunk. Returns null if the lane is exhausted. */
function advanceOrFinish(
  plan: { startNonce: bigint; workers: number; laneChunkSize: number },
  worker: number,
  curNonce: bigint,
  curChunk: number,
): { nextNonce: bigint; chunkIndex: number; exhausted: boolean } | null {
  const nextWindow = allocateWindow(plan, worker, curChunk + 1);
  if (nextWindow.size === 0n) {
    // Lane fully consumed: pin nextNonce to a valid uint64 (final nonce of last chunk).
    const done = allocateWindow(plan, worker, curChunk);
    return { nextNonce: done.toNonce, chunkIndex: curChunk, exhausted: true };
  }
  return { nextNonce: nextWindow.fromNonce, chunkIndex: curChunk + 1, exhausted: false };
}

function post(msg: WorkerToMainMsg): void {
  (process as any).send?.(msg);
}

function runWorker(state: {
  workerId: number;
  totalWorkers: number;
  laneChunkSize: number;
  startNonce: bigint;
  header: BlockHeader;
  budget: number;
  chunkYield: number;
  reportNonces: boolean;
  nonce: bigint;
  chunkIndex: number;
  attemptedHere: number;
  exhausted: boolean;
  stop: boolean;
}): void {
  const plan = {
    startNonce: state.startNonce,
    workers: state.totalWorkers,
    laneChunkSize: state.laneChunkSize,
  };
  const { header, chunkYield } = state;
  let probedNonces: string[] = [];

  while (!state.stop && state.attemptedHere < state.budget && !state.exhausted) {
    const membership = laneMembership(plan, state.nonce);
    if (!membership.ok || membership.lane !== state.workerId || membership.ownChunkIndex < state.chunkIndex) {
      post({ type: "error", workerId: state.workerId, message: `worker ${state.workerId}: live position 0x${state.nonce.toString(16)} left its lane` });
      return;
    }
    state.chunkIndex = membership.ownChunkIndex;
    const window = allocateWindow(plan, state.workerId, state.chunkIndex);
    if (window.size === 0n) {
      const advanced = advanceOrFinish(plan, state.workerId, state.nonce, state.chunkIndex);
      if (!advanced) return;
      state.nonce = advanced.nextNonce;
      state.chunkIndex = advanced.chunkIndex;
      state.exhausted = advanced.exhausted;
      if (state.exhausted) return;
      continue;
    }
    if (state.nonce > window.toNonce) {
      const advanced = advanceOrFinish(plan, state.workerId, state.nonce, state.chunkIndex);
      if (!advanced) return;
      state.nonce = advanced.nextNonce;
      state.chunkIndex = advanced.chunkIndex;
      state.exhausted = advanced.exhausted;
      if (state.exhausted) return;
      continue;
    }

    const batchBudget = Math.min(chunkYield, state.budget - state.attemptedHere);
    const batchEndExclusive =
      state.nonce + BigInt(batchBudget) > window.toNonce + 1n
        ? window.toNonce + 1n
        : state.nonce + BigInt(batchBudget);
    probedNonces = [];
    while (state.nonce < batchEndExclusive && !state.stop) {
      if (isMiningCandidate(header, state.nonce)) {
        post({ type: "candidate", workerId: state.workerId, nonce: "0x" + state.nonce.toString(16).padStart(16, "0") });
        probedNonces.push(state.nonce.toString(16));
        post({ type: "progress", workerId: state.workerId, nextNonce: "0x" + (state.nonce + 1n).toString(16).padStart(16, "0"), attemptedHere: state.attemptedHere + 1, chunkIndex: state.chunkIndex, exhausted: state.exhausted, probedNonces: state.reportNonces ? probedNonces : [] });
        post({ type: "done", workerId: state.workerId, attempts: state.attemptedHere + 1, nextNonce: "0x" + (state.nonce + 1n).toString(16).padStart(16, "0"), chunkIndex: state.chunkIndex, exhausted: state.exhausted });
        return;
      }
      probedNonces.push(state.nonce.toString(16));
      state.nonce += 1n;
      state.attemptedHere += 1;
    }

    if (state.stop) return;

    // After the batch, advance to the next own-lane chunk if we've
    // completed the current one.
    if (state.nonce > window.toNonce) {
      const advanced = advanceOrFinish(plan, state.workerId, state.nonce, state.chunkIndex);
      if (!advanced) {
        post({ type: "done", workerId: state.workerId, attempts: state.attemptedHere, nextNonce: "0x" + state.nonce.toString(16).padStart(16, "0"), chunkIndex: state.chunkIndex, exhausted: state.exhausted });
        return;
      }
      state.nonce = advanced.nextNonce;
      state.chunkIndex = advanced.chunkIndex;
      state.exhausted = advanced.exhausted;
      if (state.exhausted) {
        post({ type: "done", workerId: state.workerId, attempts: state.attemptedHere, nextNonce: "0x" + state.nonce.toString(16).padStart(16, "0"), chunkIndex: state.chunkIndex, exhausted: state.exhausted });
        return;
      }
    }

    post({
      type: "progress",
      workerId: state.workerId,
      nextNonce: "0x" + state.nonce.toString(16).padStart(16, "0"),
      attemptedHere: state.attemptedHere,
      chunkIndex: state.chunkIndex,
      exhausted: state.exhausted,
      probedNonces: state.reportNonces ? probedNonces : [],
    });
  }

  post({ type: "done", workerId: state.workerId, attempts: state.attemptedHere, nextNonce: "0x" + state.nonce.toString(16).padStart(16, "0"), chunkIndex: state.chunkIndex, exhausted: state.exhausted });
}

// Parse worker init data from the MINING_WORKER_DATA environment variable.
const envData = (process as any).env?.MINING_WORKER_DATA;
if (!envData) {
  throw new Error("worker process requires MINING_WORKER_DATA environment variable");
}

const raw = JSON.parse(envData) as {
  workerId: number;
  totalWorkers: number;
  laneChunkSize: number;
  startNonce: string; // "0x"-prefixed hex
  header: {
    parentHash: string;
    number: number;
    timestamp: number;
    difficulty: string; // "0x"-prefixed hex or decimal
    coinbase: string;
    extraData: string; // hex (no 0x prefix)
    gasLimit: string; // "0x"-prefixed hex or decimal
    gasUsed: string; // "0x"-prefixed hex or decimal
    transactionsRoot: string;
    stateRoot: string;
    nonce: string; // "0x"-prefixed hex or decimal
  };
  budget: number;
  chunkYield: number;
  reportNonces: boolean;
  exhausted: boolean;
  startNonceOverride: string; // "0x"-prefixed hex
  chunkIndexOverride: number;
};

const header: BlockHeader = {
  parentHash: raw.header.parentHash,
  number: raw.header.number,
  timestamp: raw.header.timestamp,
  difficulty: parseBigInt(raw.header.difficulty),
  coinbase: raw.header.coinbase,
  extraData: (() => {
    const h = raw.header.extraData;
    const bytes = [];
    for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    return new Uint8Array(bytes);
  })(),
  gasLimit: parseBigInt(raw.header.gasLimit),
  gasUsed: parseBigInt(raw.header.gasUsed),
  transactionsRoot: raw.header.transactionsRoot,
  stateRoot: raw.header.stateRoot,
  nonce: parseBigInt(raw.header.nonce),
};

const state = {
  workerId: raw.workerId,
  totalWorkers: raw.totalWorkers,
  laneChunkSize: raw.laneChunkSize,
  startNonce: parseBigInt(raw.startNonce),
  header,
  budget: raw.budget,
  chunkYield: raw.chunkYield,
  reportNonces: raw.reportNonces,
  exhausted: raw.exhausted === true,
  nonce: parseBigInt(raw.startNonceOverride),
  chunkIndex: raw.chunkIndexOverride,
  attemptedHere: 0,
  stop: false,
};

// Listen for stop messages from the main process.
process.on("message", (msg: MainToWorkerMsg) => {
  if (msg.type === "stop") state.stop = true;
});

runWorker(state);
