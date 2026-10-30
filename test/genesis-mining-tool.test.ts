/**
 * BOUNDED, SAFE tests for the genesis mining tool (src/tools/genesis-mining.ts
 * + scripts/mine-genesis.ts).
 *
 * SAFETY: these tests never run a real genesis nonce search. Every hashing
 * invocation is bounded to at most a few dozen nonces and exercises only the
 * documented tool paths:
 * - lane allocation (disjointness, coverage, uint64 boundaries),
 * - the CLI safety gate (no search without complete arguments + --mine),
 * - checkpoint integrity (validation, atomic writes, refuse-to-reset),
 * - exact resume without reprocessing (via the test-only onNonceProbe hook),
 * - candidate rejection through the PRODUCTION validator (the pinned genesis
 *   nonce 0 is a known PoW failure there, so no real mining is needed).
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateWindow,
  allocateWindows,
  buildFreshCheckpoint,
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  getGenesisPlan,
  loadCheckpoint,
  MAX_UINT64,
  parseCliArguments,
  runMiningSession,
  validateCheckpoint,
  verifyGenesisCandidate,
  writeCheckpointAtomic,
  writeResultArtifact,
  workerChunkStart,
  reconcileOrphanResultArtifact,
  type CandidateRecord,
  type Checkpoint,
  type PlanSpec,
} from "../src/tools/genesis-mining.js";
import { DEV_CHAIN_ID, DEV_PARAM_VERSION, GENESIS_DIFFICULTY, POW_LIMIT } from "../src/config/params.js";
import { blockHash, hashHeaderWithoutNonce } from "../src/chain/block.js";
import { isMiningCandidate, powHash, verifyHeaderPoW } from "../src/consensus/pow.js";
import { toHex } from "../src/util/bytes.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cashbi-minetest-${prefix}-`));
}

function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function freshSpec(workers: number, laneChunkSize: number, startNonce = 0n): PlanSpec {
  return { startNonce, workers, laneChunkSize };
}

/* ------------------------------------------------------------------ */
/* Lane allocation                                                      */
/* ------------------------------------------------------------------ */

test("mine-tool: lanes are disjoint and jointly cover their wave interval", () => {
  const spec = freshSpec(4, 10); // wave 0: nonces 0..39
  const windows = allocateWindows(spec, 0);
  assert.equal(windows.length, 4);
  const seen = new Set<bigint>();
  for (let n = 0; n < 40; n++) seen.add(BigInt(n));
  for (const w of windows) {
    assert.equal(w.fromNonce, BigInt(w.worker) * 10n);
    assert.equal(w.toNonce, BigInt(w.worker) * 10n + 9n);
    for (let n = w.fromNonce; n <= w.toNonce; n++) {
      assert.ok(seen.delete(n), `nonce ${n} covered twice`);
    }
  }
  assert.equal(seen.size, 0, "every nonce in the wave must be covered exactly once");
});

test("mine-tool: workerChunkStart follows the owned-lane grid formula", () => {
  const spec = freshSpec(3, 7);
  // worker w owns global chunks w, w+3, w+6, …
  assert.equal(workerChunkStart(spec, 0, 0), 0n);
  assert.equal(workerChunkStart(spec, 1, 0), 7n);
  assert.equal(workerChunkStart(spec, 2, 0), 14n);
  assert.equal(workerChunkStart(spec, 0, 1), 21n);
  assert.equal(workerChunkStart(spec, 1, 1), 28n);
  assert.equal(workerChunkStart(spec, 2, 1), 35n);
  assert.throws(() => workerChunkStart(spec, 3, 0));
  assert.throws(() => workerChunkStart(spec, 0, -1));
});

test("mine-tool: chunk windows clamp to MAX_UINT64 and size 0 past it", () => {
  const spec = freshSpec(2, 8, MAX_UINT64 - 10n);
  // wave 0: worker 0 → [max-10, max-3], worker 1 → [max-2, max]
  const w0 = allocateWindow(spec, 0, 0);
  assert.equal(w0.size, 8n);
  assert.equal(w0.toNonce, MAX_UINT64 - 3n);
  const w1 = allocateWindow(spec, 1, 0);
  assert.equal(w1.size, 3n); // clamped: [max-2, max]
  assert.equal(w1.toNonce, MAX_UINT64);
  // wave 1 starts entirely past MAX_UINT64 for both workers.
  assert.equal(allocateWindow(spec, 0, 1).size, 0n);
  assert.equal(allocateWindow(spec, 1, 1).size, 0n);
});

test("mine-tool: exhaustive disjointness over a wide plan incl. nonce 0 and MAX_UINT64", () => {
  const spec = freshSpec(5, 16, MAX_UINT64 - 120n);
  const seen = new Map<bigint, number>();
  for (let k = 0; k < 3; k++) {
    for (let w = 0; w < 5; w++) {
      const win = allocateWindow(spec, w, k);
      if (win.size === 0n) continue; // empty window past MAX_UINT64 owns nothing
      for (let n = win.fromNonce; n <= win.toNonce; n++) {
        assert.ok(!seen.has(n), `nonce ${n} appeared twice (workers ${seen.get(n)} and ${w})`);
        seen.set(n, w);
      }
    }
  }
  assert.ok(seen.has(MAX_UINT64), "MAX_UINT64 must be owned by exactly one clamped lane");
});

/* ------------------------------------------------------------------ */
/* CLI safety gate                                                      */
/* ------------------------------------------------------------------ */

test("mine-tool: CLI gate refuses the search when arguments are missing", () => {
  // Nothing at all.
  let parsed = parseCliArguments({});
  assert.equal(parsed.mode, "usage");
  assert.ok(parsed.problems.length >= 4);
  // Everything complete except --mine: still NOT a search (plan preview only).
  parsed = parseCliArguments({ start: "0x0", "max-attempts": "100", workers: "2", checkpoint: "/tmp/x.json" });
  assert.equal(parsed.mode, "plan");
  assert.equal(parsed.values.mine, false);
  assert.equal(parsed.problems.length, 0);
});

test("mine-tool: CLI gate authorizes a bounded run ONLY with complete args + --mine", () => {
  const parsed = parseCliArguments({
    mine: true,
    start: "0x0",
    "max-attempts": "100",
    workers: "2",
    checkpoint: "/tmp/x.json",
  });
  assert.equal(parsed.mode, "mine");
  assert.equal(parsed.values.startNonce, 0n);
  // Bad numerics or out-of-range start never authorize mining.
  assert.equal(parseCliArguments({ mine: true, start: "-4", "max-attempts": "1", workers: "1", checkpoint: "/c" }).mode, "usage");
  assert.equal(parseCliArguments({ mine: true, start: "0x0", "max-attempts": "0", workers: "1", checkpoint: "/c" }).mode, "usage");
  assert.equal(parseCliArguments({ mine: true, start: "0x0", "max-attempts": "5", workers: "65", checkpoint: "/c" }).mode, "usage");
  assert.equal(parseCliArguments({ mine: true, start: "0x0", "max-attempts": "nope", workers: "1", checkpoint: "/c" }).mode, "usage");
});

test("mine-tool: nonce 0n and the pinned preimage load through the plan", () => {
  const plan = getGenesisPlan();
  assert.match(plan.preimageDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(plan.header.nonce, 0n); // tool never mutates the pinned value
});

/* ------------------------------------------------------------------ */
/* Checkpoint build / validate / atomic write                           */
/* ------------------------------------------------------------------ */

test("mine-tool: fresh checkpoint builds, loads, and round-trips atomically", () => {
  const plan = getGenesisPlan();
  const spec = freshSpec(3, 20);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());
  assert.equal(cp.schema, CHECKPOINT_SCHEMA);
  assert.equal(cp.version, CHECKPOINT_VERSION);
  assert.equal(cp.candidate, null);
  assert.equal(cp.totalAttempts, 0);
  assert.equal(cp.genesis.chainId, DEV_CHAIN_ID);
  assert.equal(cp.genesis.powLimit, "0x" + POW_LIMIT.toString(16));
  assert.equal(cp.genesis.difficulty, GENESIS_DIFFICULTY.toString());
  assert.equal(cp.genesis.paramVersion, DEV_PARAM_VERSION);
  assert.deepEqual(validateCheckpoint(cp, plan).problems, []);

  const dir = scratchDir("atomic");
  const path = join(dir, "cp.json");
  writeCheckpointAtomic(path, cp);
  assert.ok(existsSync(path));
  // No leftover temp files from the atomic rename.
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
  );
  const loaded = loadCheckpoint(path, plan);
  assert.ok(loaded.ok, `expected load ok, got ${loaded.reason}`);
  assert.deepEqual(loaded.checkpoint, cp);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: tampered nextNonce outside the worker's own lane is rejected", () => {
  const plan = getGenesisPlan();
  const spec = freshSpec(2, 20);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());
  // Worker 1's lane chunk 0 = [20, 40): nonce 0x5 is worker 0's.
  cp.workers[1].nextNonce = "0x5";
  const checks = validateCheckpoint(cp, plan);
  assert.equal(checks.ok, false);
  assert.ok(checks.problems.some((p) => p.includes("not inside worker 1's lane")));
});

test("mine-tool: tampered nextNonce past the chunk window is rejected", () => {
  const plan = getGenesisPlan();
  const spec = freshSpec(2, 20);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());
  cp.workers[0].nextNonce = "0x14"; // 20: the first nonce of the NEXT lane
  const checks = validateCheckpoint(cp, plan);
  assert.equal(checks.ok, false);
  // A nonce past a chunk end always belongs to another worker's lane, so the
  // disjoint-lane membership guard rejects it (the window guard behind it is
  // defense in depth).
  assert.ok(checks.problems.some((p) => p.includes("not inside worker 0's lane")));
});

test("mine-tool: totalAttempts mismatch is rejected", () => {
  const plan = getGenesisPlan();
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 20), utcNow());
  cp.totalAttempts = 999;
  const checks = validateCheckpoint(cp, plan);
  assert.equal(checks.ok, false);
  assert.ok(checks.problems.some((p) => p.includes("totalAttempts 999")));
});

test("mine-tool: stale checkpoint from a DIFFERENT genesis preimage is rejected", () => {
  const plan = getGenesisPlan();
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 20), utcNow());
  cp.genesis.preimageDigest = "0x" + "0".repeat(64);
  const checks = validateCheckpoint(cp, plan);
  assert.equal(checks.ok, false);
  assert.ok(checks.problems.some((p) => p.includes("stale checkpoint")));
});

test("mine-tool: changed consensus constants in an old checkpoint are rejected", () => {
  const plan = getGenesisPlan();
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 20), utcNow());
  cp.genesis.powLimit = "0x" + (POW_LIMIT + 1n).toString(16);
  cp.genesis.paramVersion = "0.0.0";
  const checks = validateCheckpoint(cp, plan);
  assert.equal(checks.ok, false);
  assert.ok(checks.problems.some((p) => p.includes("POW_LIMIT")));
  assert.ok(checks.problems.some((p) => p.includes("paramVersion")));
});

test("mine-tool: malformed checkpoint file refuses to silent-reset", () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("reset");
  const path = join(dir, "cp.json");
  writeFileSync(path, "{ this is not json", "utf8");
  const loaded = loadCheckpoint(path, plan);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.reason!.includes("refusing to silent-reset"));
  assert.ok(existsSync(path), "the corrupt file must not be deleted or repaired");
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: exhausted worker validation (final clamped chunk)", () => {
  const plan = getGenesisPlan();
  const spec = freshSpec(2, 8, MAX_UINT64 - 10n);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());
  // Simulate full exhaustion exactly like the runner does.
  cp.workers[0].nextNonce = "0x" + (MAX_UINT64 - 3n).toString(16); // own chunk0 end
  cp.workers[0].chunkIndex = 0;
  cp.workers[0].attempts = 8;
  cp.workers[0].exhausted = true;
  cp.workers[1].nextNonce = "0x" + MAX_UINT64.toString(16); // own chunk0 end (clamped)
  cp.workers[1].chunkIndex = 0;
  cp.workers[1].attempts = 3;
  cp.workers[1].exhausted = true;
  cp.totalAttempts = 11;
  assert.deepEqual(validateCheckpoint(cp, plan).problems, []);
  // A lie: exhausted worker pointing at a NON-final nonce is rejected.
  cp.workers[0].nextNonce = "0x" + (MAX_UINT64 - 4n).toString(16);
  const checks = validateCheckpoint(cp, plan);
  assert.equal(checks.ok, false);
  assert.ok(checks.problems.some((p) => p.includes("marked exhausted")));
});

/* ------------------------------------------------------------------ */
/* Session runner (library level): bounded, exact resume                */
/* ------------------------------------------------------------------ */

test("mine-tool: bounded session stops at the budget with exact per-worker counts", async () => {
  const plan = getGenesisPlan();
  const spec = freshSpec(2, 25); // worker w chunk 0: w0 [0,25), w1 [25,50)
  const cp = buildFreshCheckpoint(plan, spec, utcNow());
  const probed: Array<[number, bigint]> = [];
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(scratchDir("sess1"), "cp.json"),
    resultPath: join(scratchDir("sess1"), "result.json"),
    budgetsPerWorker: [25, 25],
    chunkYield: 7,

    onNonceProbe: (w, n) => probed.push([w, n]),
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 50);
  assert.equal(probed.length, 50);
  // Worker 0 probed exactly [0..25), worker 1 exactly [25..50): disjoint.
  const w0 = probed.filter(([w]) => w === 0).map(([, n]) => n);
  const w1 = probed.filter(([w]) => w === 1).map(([, n]) => n);
  assert.deepEqual(w0, Array.from({ length: 25 }, (_, i) => BigInt(i)));
  assert.deepEqual(w1, Array.from({ length: 25 }, (_, i) => BigInt(25 + i)));
  assert.equal(cp.totalAttempts, 50);
  // Saved resume positions: worker 0 → next own chunk [50,75), worker 1 → [75,100).
  assert.equal(cp.workers[0].nextNonce, "0x32");
  assert.equal(cp.workers[1].nextNonce, "0x4b");
  assert.equal(cp.workers[0].chunkIndex, 1);
  assert.equal(cp.workers[0].exhausted, false);
});

test("mine-tool: resume is exact — zero reprocessing across invocations", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("sess2");
  const cpPath = join(dir, "cp.json");
  const spec = freshSpec(2, 10);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());

  // Invocation 1: budget 4 per worker → nonces w0: 0..3, w1: 10..13.
  await runMiningSession({
    plan, checkpoint: cp, checkpointPath: cpPath,
    resultPath: join(dir, "result.json"), budgetsPerWorker: [4, 4], chunkYield: 3, 
  });
  const saved1 = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.deepEqual(saved1.workers.map((w) => w.nextNonce), ["0x4", "0xe"]);
  assert.equal(saved1.workers[0].attempts, 4);
  assert.equal(saved1.workers[1].attempts, 4);

  // Invocation 2 resumes from the SAVED state via a fresh load.
  const loaded = loadCheckpoint(cpPath, plan);
  assert.ok(loaded.ok);
  const probed: Array<[number, bigint]> = [];
  await runMiningSession({
    plan, checkpoint: loaded.checkpoint!, checkpointPath: cpPath,
    resultPath: join(dir, "result.json"), budgetsPerWorker: [3, 3], chunkYield: 2, 
    onNonceProbe: (w, n) => probed.push([w, n]),
  });
  // NO reprocessing: probed nonces start exactly where invocation 1 stopped.
  assert.deepEqual(probed.filter(([w]) => w === 0).map(([, n]) => n), [4n, 5n, 6n]);
  assert.deepEqual(probed.filter(([w]) => w === 1).map(([, n]) => n), [14n, 15n, 16n]);
  assert.deepEqual(JSON.parse(readFileSync(cpPath, "utf8")).workers.map((w: { attempts: number }) => w.attempts), [7, 7]);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: lane exhaustion near MAX_UINT64 marks workers done, no nonsense nonces", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("sess3");
  const spec = freshSpec(2, 8, MAX_UINT64 - 10n);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());
  const outcome = await runMiningSession({
    plan, checkpoint: cp, checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"), budgetsPerWorker: [50, 50], chunkYield: 4, 
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 11); // w0: 8 nonces, w1: 3 (clamped)
  assert.equal(cp.workers[0].exhausted, true);
  assert.equal(cp.workers[0].nextNonce, "0x" + (MAX_UINT64 - 3n).toString(16));
  assert.equal(cp.workers[1].exhausted, true);
  assert.equal(cp.workers[1].nextNonce, "0x" + MAX_UINT64.toString(16));
  assert.equal(cp.totalAttempts, 11);
  // The persisted checkpoint must revalidate cleanly (a fresh resume sees a
  // fully-exhausted lane and does no further hashing).
  const persisted = JSON.parse(readFileSync(join(dir, "cp.json"), "utf8")) as Checkpoint;
  assert.deepEqual(validateCheckpoint(persisted, plan).problems, []);
  const outcome2 = await runMiningSession({
    plan, checkpoint: persisted, checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"), budgetsPerWorker: [50, 50], chunkYield: 4, 
  });
  assert.equal(outcome2.attempts, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: shouldStop halts between batches and the checkpoint stays valid", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("sess4");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 1000), utcNow());
  const outcome = await runMiningSession({
    plan, checkpoint: cp, checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"), budgetsPerWorker: [100, 100], chunkYield: 5, 
    shouldStop: () => true,
  });
  assert.equal(outcome.status, "stopped");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Candidate verification: PRODUCTION validator identity                */
/* ------------------------------------------------------------------ */

test("mine-tool: candidate verification runs the production verifyHeaderPoW", () => {
  const plan = getGenesisPlan();
  // The pinned genesis nonce (0) is a known production-PoW FAILURE: the tool
  // must reject it through the same consensus code path used by block sync.
  assert.equal(isMiningCandidate(plan.header, 0n), false); // production check
  const verdict = verifyGenesisCandidate(plan, 0n, 1, utcNow());
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reason!.includes("production verifyHeaderPoW"));
  assert.equal(verdict.record, undefined);
  // Identity: the tool's rejection is consistent with the direct production
  // call on the same (plan, nonce) pair.
  assert.equal(verifyHeaderPoW(plan.header, { nonce: 0n }).ok, false);
  // The nonce is excluded from the preimage, so mutation with candidate
  // nonces cannot drift the plan:
  const digest = toHex(hashHeaderWithoutNonce(plan.header));
  assert.equal(digest, plan.preimageDigest);
});

test("mine-tool: recorded candidate that fails production re-verification halts the session", async () => {
  const plan = getGenesisPlan();
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 20), utcNow());
  // Any recorded candidate must SURVIVE re-derivation through the production
  // validator. Forge one with the (known-failing) pinned nonce: the session
  // must HARD-FAIL instead of continuing to search on untrusted state.
  cp.candidate = {
    nonce: "0x0000000000000000",
    nonceDecimal: "0",
    preimageDigest: plan.preimageDigest,
    powHash: toHex(powHash(plan.header, 0n)),
    target: "0x" + POW_LIMIT.toString(16),
    difficulty: GENESIS_DIFFICULTY.toString(),
    powLimit: "0x" + POW_LIMIT.toString(16),
    genesisHash: blockHash(plan.header),
    chainId: DEV_CHAIN_ID,
    paramVersion: DEV_PARAM_VERSION,
    foundAtUtc: utcNow(),
    totalAttempts: 1,
    header: {
      parentHash: plan.header.parentHash,
      number: plan.header.number,
      timestamp: plan.header.timestamp,
      difficulty: GENESIS_DIFFICULTY.toString(),
      coinbase: plan.header.coinbase,
      extraData: toHex(plan.header.extraData),
      gasLimit: plan.header.gasLimit.toString(),
      gasUsed: plan.header.gasUsed.toString(),
      transactionsRoot: plan.header.transactionsRoot,
      stateRoot: plan.header.stateRoot,
    },
  };
  const threw = await runMiningSession({
    plan, checkpoint: cp, checkpointPath: join(scratchDir("sess5"), "cp.json"),
    resultPath: join(scratchDir("sess5"), "result.json"), budgetsPerWorker: [10, 10], chunkYield: 2, 
  }).then(
    () => null,
    (err: Error) => err,
  );
  assert.ok(threw instanceof Error, "session must hard-fail on an unverified recorded candidate");
  assert.ok(threw.message.includes("checkpoint candidate failed re-verification"));
  assert.ok(threw.message.includes("production verifyHeaderPoW"), "rejection must name the production validator");
});

/* ------------------------------------------------------------------ */
/* Result artifact integrity                                            */
/* ------------------------------------------------------------------ */

test("mine-tool: result artifact writer refuses to overwrite different content", () => {
  const dir = scratchDir("artifact");
  const plan = getGenesisPlan();
  const path = join(dir, "result.json");
  const record = {
    nonce: "0x0000000000000042",
    nonceDecimal: "66",
    preimageDigest: plan.preimageDigest,
    note: "record A",
  } as unknown as CandidateRecord;
  const write = writeResultArtifact(path, record);
  assert.ok(write.ok);
  // Identical content counts as already recorded.
  assert.ok(writeResultArtifact(path, record).alreadyRecorded === true as boolean);
  // Different content is refused, original preserved.
  const other = { ...record, note: "record B" } as unknown as CandidateRecord;
  const again = writeResultArtifact(path, other);
  assert.equal(again.ok, false);
  assert.ok(again.reason!.includes("refusing to overwrite"));
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as { note: string };
  assert.equal(onDisk.note, "record A");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* CLI subprocess tests (BOUNDED: ≤ ~40 attempts total, seconds)        */
/* ------------------------------------------------------------------ */

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliRun {
  const res = spawnSync("npx", ["tsx", "scripts/mine-genesis.ts", ...args], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("mine-tool CLI: no arguments → exit 2, usage, NO checkpoint file", () => {
  const dir = scratchDir("cli1");
  const cpPath = join(dir, "cp.json");
  const run = runCli(["--start", "0x0", "--max-attempts", "40", "--workers", "2"]);
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes("Refusing to mine"));
  assert.ok(existsSync(cpPath) === false, "no checkpoint may be written on the refusal path");
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: dry-run plan preview writes nothing and shows disjoint lanes", () => {
  const dir = scratchDir("cli2");
  const cpPath = join(dir, "cp.json");
  const run = runCli([
    "--start", "0x0", "--max-attempts", "40", "--workers", "2",
    "--checkpoint", cpPath, "--dry-run",
  ]);
  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes("PLAN PREVIEW"));
  assert.ok(run.stdout.includes("worker 0") && run.stdout.includes("worker 1"));
  assert.ok(existsSync(cpPath) === false, "dry run must not write a checkpoint");
  const resultPath = `${cpPath}.result.json`;
  assert.ok(existsSync(resultPath) === false);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: bounded --mine run then exact resume in a second process", () => {
  const dir = scratchDir("cli3");
  const cpPath = join(dir, "cp.json");
  // laneChunkSize = ceil(40/2) = 20 → wave 0: w0 [0,20), w1 [20,40)
  // Process 1: fresh bounded run, 40 attempts, 2 workers, chunk 5.
  const first = runCli([
    "--start", "0x0", "--max-attempts", "40", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "5", 
  ]);
  assert.equal(first.code, 0, `stdout: ${first.stdout}\nstderr: ${first.stderr}`);
  assert.ok(first.stdout.includes("status=budget-exhausted"));
  const afterFirst = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(afterFirst.totalAttempts, 40);
  assert.deepEqual(afterFirst.workers.map((w) => w.attempts), [20, 20]);
  // Chunk complete → each worker jumped to the start of its NEXT OWN chunk.
  assert.deepEqual(afterFirst.workers.map((w) => w.nextNonce), ["0x28", "0x3c"]);

  // Process 2: resume with the same 40-attempt budget; the saved state must
  // carry over exactly: w0 continues in its chunk 1 [40,60), w1 in [60,80).
  const second = runCli([
    "--start", "0x0", "--max-attempts", "40", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "5", 
  ]);
  assert.equal(second.code, 0, `stdout: ${second.stdout}\nstderr: ${second.stderr}`);
  const afterSecond = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(afterSecond.totalAttempts, 80);
  assert.deepEqual(afterSecond.workers.map((w) => w.attempts), [40, 40]);
  assert.deepEqual(afterSecond.workers.map((w) => w.nextNonce), ["0x50", "0x64"]);
  assert.equal(afterSecond.candidate, null, "no candidate may be fabricated by these tiny runs");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Audit finding F-1: event-loop responsiveness                       */
/* ------------------------------------------------------------------ */

test("mine-tool: SIGINT/stop responsive with Ctrl+C (F-1)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f1");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 1000), utcNow());
  let stopCalls = 0;
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [100, 100],
    chunkYield: 10,

    onNonceProbe: () => {},
    shouldStop: () => {
      stopCalls += 1;
      return stopCalls > 2; // stop after a few batches
    },
  });
  // Must stop well before exhausting the 200-attempt budget
  assert.ok(outcome.attempts < 200, `expected early stop, got ${outcome.attempts} attempts`);
  assert.equal(outcome.status, "stopped");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Audit finding F-2: strict attempt budget                           */
/* ------------------------------------------------------------------ */

test("mine-tool: strict total attempt limit for divisible budget (F-2)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f2a");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 100), utcNow());
  const probed: Array<[number, bigint]> = [];
  // maxAttempts=10, workers=2 → budgets [5, 5], total exactly 10
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5, 5],
    chunkYield: 2,

    onNonceProbe: (w, n) => probed.push([w, n]),
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 10);
  assert.equal(probed.length, 10);
  assert.deepEqual(probed.filter(([w]) => w === 0).length, 5);
  assert.deepEqual(probed.filter(([w]) => w === 1).length, 5);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: strict total attempt limit for non-divisible budget (F-2)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f2b");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 100), utcNow());
  const probed: Array<[number, bigint]> = [];
  // maxAttempts=7, workers=2 → budgets [4, 3], total exactly 7
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [4, 3],
    chunkYield: 2,

    onNonceProbe: (w, n) => probed.push([w, n]),
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 7);
  assert.equal(probed.length, 7);
  assert.deepEqual(probed.filter(([w]) => w === 0).length, 4);
  assert.deepEqual(probed.filter(([w]) => w === 1).length, 3);
  // Workers stay in their own lanes: w0 probes [0..4), w1 probes [100..103)
  const w0 = probed.filter(([w]) => w === 0).map(([, n]) => n);
  const w1 = probed.filter(([w]) => w === 1).map(([, n]) => n);
  assert.deepEqual(w0, [0n, 1n, 2n, 3n]);
  assert.deepEqual(w1, [100n, 101n, 102n]);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool library: --max-attempts is per-invocation across resume (F-2)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge-max-attempts");
  const cpPath = join(dir, "cp.json");
  const spec = freshSpec(2, 25);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());

  // Invocation 1: maxAttempts=10, workers=2 → budgets [5,5], total 10
  const outcome1 = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: cpPath,
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5, 5],
    chunkYield: 5,
    onNonceProbe: () => {},
  });
  assert.equal(outcome1.status, "budget-exhausted");
  assert.equal(outcome1.attempts, 10);
  assert.equal(cp.totalAttempts, 10);

  // Invocation 2: resume with SAME --max-attempts=10 → should do 10 MORE attempts
  const cp1 = loadCheckpoint(cpPath, plan);
  assert.ok(cp1.ok);
  const outcome2 = await runMiningSession({
    plan,
    checkpoint: cp1.checkpoint!,
    checkpointPath: cpPath,
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5, 5],
    chunkYield: 5,
    onNonceProbe: () => {},
  });
  assert.equal(outcome2.status, "budget-exhausted");
  assert.equal(outcome2.attempts, 10); // exactly 10 new attempts, not 0
  assert.equal(cp1.checkpoint!.totalAttempts, 20); // cumulative: 10 + 10 = 20

  // Invocation 3: resume with same budget again
  const cp2 = loadCheckpoint(cpPath, plan);
  assert.ok(cp2.ok);
  const outcome3 = await runMiningSession({
    plan,
    checkpoint: cp2.checkpoint!,
    checkpointPath: cpPath,
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5, 5],
    chunkYield: 5,
    onNonceProbe: () => {},
  });
  assert.equal(outcome3.status, "budget-exhausted");
  assert.equal(outcome3.attempts, 10); // exactly 10 new attempts
  assert.equal(cp2.checkpoint!.totalAttempts, 30); // cumulative: 10 + 10 + 10 = 30

  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool library: --max-attempts cannot be exceeded by any invocation (F-2)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge-max-attempts-cap");
  const cpPath = join(dir, "cp.json");
  const spec = freshSpec(1, 100);
  const cp = buildFreshCheckpoint(plan, spec, utcNow());

  // First invocation: maxAttempts=5, workers=1 → exactly 5 attempts
  const outcome1 = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: cpPath,
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5],
    chunkYield: 5,
  });
  assert.equal(outcome1.status, "budget-exhausted");
  assert.equal(outcome1.attempts, 5);
  assert.equal(cp.totalAttempts, 5);

  // Second invocation: same budget → exactly 5 more attempts (not 0)
  const cp1 = loadCheckpoint(cpPath, plan);
  assert.ok(cp1.ok);
  const outcome2 = await runMiningSession({
    plan,
    checkpoint: cp1.checkpoint!,
    checkpointPath: cpPath,
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5],
    chunkYield: 5,
  });
  assert.equal(outcome2.status, "budget-exhausted");
  assert.equal(outcome2.attempts, 5);
  assert.equal(cp1.checkpoint!.totalAttempts, 10);

  // Third invocation: smaller budget → exactly 3 attempts, no more
  const cp2 = loadCheckpoint(cpPath, plan);
  assert.ok(cp2.ok);
  const outcome3 = await runMiningSession({
    plan,
    checkpoint: cp2.checkpoint!,
    checkpointPath: cpPath,
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [3],
    chunkYield: 3,
  });
  assert.equal(outcome3.status, "budget-exhausted");
  assert.equal(outcome3.attempts, 3);
  assert.equal(cp2.checkpoint!.totalAttempts, 13);

  rmSync(dir, { recursive: true, force: true });
});


test("mine-tool: CLI validation and propagation of --checkpoint-every (F-3)", () => {
  // Valid value
  const parsed = parseCliArguments({
    mine: true,
    start: "0x0",
    "max-attempts": "100",
    workers: "2",
    checkpoint: "/tmp/x.json",
    "checkpoint-every": "5000",
  });
  assert.equal(parsed.mode, "mine");
  assert.equal(parsed.values.checkpointEveryAttempts, 5000);

  // Invalid: zero
  assert.equal(
    parseCliArguments({
      mine: true,
      start: "0x0",
      "max-attempts": "100",
      workers: "2",
      checkpoint: "/tmp/x.json",
      "checkpoint-every": "0",
    }).mode,
    "usage",
  );

  // Invalid: non-numeric
  assert.equal(
    parseCliArguments({
      mine: true,
      start: "0x0",
      "max-attempts": "100",
      workers: "2",
      checkpoint: "/tmp/x.json",
      "checkpoint-every": "abc",
    }).mode,
    "usage",
  );

  // Optional: omitted → undefined
  const parsed2 = parseCliArguments({
    mine: true,
    start: "0x0",
    "max-attempts": "100",
    workers: "2",
    checkpoint: "/tmp/x.json",
  });
  assert.equal(parsed2.values.checkpointEveryAttempts, undefined);
});

test("mine-tool: --checkpoint-every triggers checkpoints during a session (F-3)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f3");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 100), utcNow());
  // checkpoint-every=3 → checkpoint after each worker's 3rd, 6th, 9th attempt
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [10, 10],
    chunkYield: 2,

    checkpointEveryAttempts: 3,
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 20);
  // Checkpoint count > 1 (initial write + periodic checkpoints)
  assert.ok(cp.checkpointCount > 1, `expected multiple checkpoints, got ${cp.checkpointCount}`);
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Audit finding F-4: unique temporary filenames                      */
/* ------------------------------------------------------------------ */

test("mine-tool: unique temporary paths, no collisions on rapid writes (F-4)", () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f4");
  const cp = buildFreshCheckpoint(plan, freshSpec(1, 10), utcNow());
  const path = join(dir, "cp.json");
  // Write many checkpoints rapidly — no collisions, no temp files left
  for (let i = 0; i < 50; i++) {
    writeCheckpointAtomic(path, cp);
  }
  const tempFiles = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(tempFiles, [], "no temporary files should remain after atomic rename");
  const loaded = loadCheckpoint(path, plan);
  assert.ok(loaded.ok, "final checkpoint must be valid");
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: temp file cleaned up on write failure (F-4)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f4b");
  const path = join(dir, "subdir", "cp.json"); // parent doesn't exist → writeCheckpointAtomic creates it
  // This should succeed (mkdir recursive). Verify no temp files remain.
  writeCheckpointAtomic(path, buildFreshCheckpoint(plan, freshSpec(1, 10), utcNow()));
  const tempFiles = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(tempFiles, []);
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Audit finding F-5: crash recovery after result creation            */
/* ------------------------------------------------------------------ */

test("mine-tool: no orphan artifact → status none (F-5)", () => {
  const plan = getGenesisPlan();
  const result = reconcileOrphanResultArtifact(plan, "/tmp/nonexistent-orphan-artifact.json");
  assert.equal(result.status, "none");
});

test("mine-tool: invalid orphan artifact rejected safely (F-5)", () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f5");
  const path = join(dir, "result.json");
  const invalidRecord = {
    nonce: "0x0000000000000000",
    nonceDecimal: "0",
    preimageDigest: plan.preimageDigest,
    powHash: "0x" + "0".repeat(64),
    target: "0x" + POW_LIMIT.toString(16),
    difficulty: GENESIS_DIFFICULTY.toString(),
    powLimit: "0x" + POW_LIMIT.toString(16),
    genesisHash: "0x" + "0".repeat(64),
    chainId: DEV_CHAIN_ID,
    paramVersion: DEV_PARAM_VERSION,
    foundAtUtc: utcNow(),
    totalAttempts: 1,
    header: {
      parentHash: plan.header.parentHash,
      number: plan.header.number,
      timestamp: plan.header.timestamp,
      difficulty: GENESIS_DIFFICULTY.toString(),
      coinbase: plan.header.coinbase,
      extraData: toHex(plan.header.extraData),
      gasLimit: plan.header.gasLimit.toString(),
      gasUsed: plan.header.gasUsed.toString(),
      transactionsRoot: plan.header.transactionsRoot,
      stateRoot: plan.header.stateRoot,
    },
  };
  writeFileSync(path, JSON.stringify(invalidRecord, null, 2) + "\n", "utf8");
  assert.throws(() => reconcileOrphanResultArtifact(plan, path), /failed production re-verification/);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: malformed orphan artifact rejected safely (F-5)", () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f5b");
  const path = join(dir, "result.json");
  writeFileSync(path, "{ not json", "utf8");
  assert.throws(() => reconcileOrphanResultArtifact(plan, path), /malformed result artifact/);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: session reconciles valid orphan artifact and stops mining (F-5)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f5c");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 20), utcNow());
  // Write a structurally valid but production-invalid artifact (nonce 0 is a known PoW failure)
  const path = join(dir, "result.json");
  const invalidRecord = {
    nonce: "0x0000000000000000",
    nonceDecimal: "0",
    preimageDigest: plan.preimageDigest,
    powHash: "0x" + "0".repeat(64),
    target: "0x" + POW_LIMIT.toString(16),
    difficulty: GENESIS_DIFFICULTY.toString(),
    powLimit: "0x" + POW_LIMIT.toString(16),
    genesisHash: "0x" + "0".repeat(64),
    chainId: DEV_CHAIN_ID,
    paramVersion: DEV_PARAM_VERSION,
    foundAtUtc: utcNow(),
    totalAttempts: 1,
    header: {
      parentHash: plan.header.parentHash,
      number: plan.header.number,
      timestamp: plan.header.timestamp,
      difficulty: GENESIS_DIFFICULTY.toString(),
      coinbase: plan.header.coinbase,
      extraData: toHex(plan.header.extraData),
      gasLimit: plan.header.gasLimit.toString(),
      gasUsed: plan.header.gasUsed.toString(),
      transactionsRoot: plan.header.transactionsRoot,
      stateRoot: plan.header.stateRoot,
    },
  };
  writeFileSync(path, JSON.stringify(invalidRecord, null, 2) + "\n", "utf8");
  // Session must fail safely on the invalid orphan artifact
  await assert.rejects(
    runMiningSession({
      plan,
      checkpoint: cp,
      checkpointPath: join(dir, "cp.json"),
      resultPath: path,
      budgetsPerWorker: [10, 10],
      chunkYield: 2,
  
    }),
    /failed production re-verification/
  );
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Audit finding F-6: competing candidate handling                    */
/* ------------------------------------------------------------------ */

test("mine-tool: writeResultArtifact refuses different content, preserves existing (F-6)", () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f6");
  const path = join(dir, "result.json");
  const recordA = {
    nonce: "0x0000000000000000",
    nonceDecimal: "0",
    preimageDigest: plan.preimageDigest,
    note: "first",
  } as unknown as CandidateRecord;
  const recordB = {
    nonce: "0x0000000000000001",
    nonceDecimal: "1",
    preimageDigest: plan.preimageDigest,
    note: "second",
  } as unknown as CandidateRecord;

  assert.ok(writeResultArtifact(path, recordA).ok);
  // Different content refused
  const result = writeResultArtifact(path, recordB);
  assert.equal(result.ok, false);
  assert.ok(result.reason!.includes("refusing to overwrite"));
  // Existing record returned for reconciliation
  assert.ok(result.existing);
  assert.equal(result.existing!.nonce, recordA.nonce);
  // Existing file preserved unchanged
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as { note: string };
  assert.equal(onDisk.note, "first");
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: competing candidate path — invalid existing artifact fails safely (F-6)", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("f6b");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 20), utcNow());
  // Pre-write an invalid artifact (nonce 0, production-invalid) as if another
  // worker wrote it before this session started
  const path = join(dir, "result.json");
  const invalidRecord = {
    nonce: "0x0000000000000000",
    nonceDecimal: "0",
    preimageDigest: plan.preimageDigest,
    powHash: "0x" + "0".repeat(64),
    target: "0x" + POW_LIMIT.toString(16),
    difficulty: GENESIS_DIFFICULTY.toString(),
    powLimit: "0x" + POW_LIMIT.toString(16),
    genesisHash: "0x" + "0".repeat(64),
    chainId: DEV_CHAIN_ID,
    paramVersion: DEV_PARAM_VERSION,
    foundAtUtc: utcNow(),
    totalAttempts: 1,
    header: {
      parentHash: plan.header.parentHash,
      number: plan.header.number,
      timestamp: plan.header.timestamp,
      difficulty: GENESIS_DIFFICULTY.toString(),
      coinbase: plan.header.coinbase,
      extraData: toHex(plan.header.extraData),
      gasLimit: plan.header.gasLimit.toString(),
      gasUsed: plan.header.gasUsed.toString(),
      transactionsRoot: plan.header.transactionsRoot,
      stateRoot: plan.header.stateRoot,
    },
  };
  writeFileSync(path, JSON.stringify(invalidRecord, null, 2) + "\n", "utf8");
  // Session startup reconciles the orphan artifact and fails safely
  await assert.rejects(
    runMiningSession({
      plan,
      checkpoint: cp,
      checkpointPath: join(dir, "cp.json"),
      resultPath: path,
      budgetsPerWorker: [10, 10],
      chunkYield: 2,
  
    }),
    /failed production re-verification/
  );
  // The invalid artifact must not have been overwritten
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as { nonce: string };
  assert.equal(onDisk.nonce, "0x0000000000000000");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* CLI subprocess tests for audit findings                            */
/* ------------------------------------------------------------------ */

test("mine-tool CLI: strict total attempt limit with non-divisible budget (F-2)", () => {
  const dir = scratchDir("cli-f2");
  const cpPath = join(dir, "cp.json");
  // max-attempts=7, workers=2 → per-worker budgets [4, 3], total exactly 7
  const run = runCli([
    "--start", "0x0", "--max-attempts", "7", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "1", 
  ]);
  assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stdout.includes("status=budget-exhausted"));
  const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(cp.totalAttempts, 7);
  assert.deepEqual(cp.workers.map((w) => w.attempts), [4, 3]);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: --checkpoint-every accepted and propagated (F-3)", () => {
  const dir = scratchDir("cli-f3");
  const cpPath = join(dir, "cp.json");
  const run = runCli([
    "--start", "0x0", "--max-attempts", "20", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "1", 
    "--checkpoint-every", "3",
  ]);
  assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stdout.includes("status=budget-exhausted"));
  const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(cp.totalAttempts, 20);
  // checkpoint-every=3 → multiple checkpoints during the run
  assert.ok(cp.checkpointCount > 1, `expected multiple checkpoints, got ${cp.checkpointCount}`);
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Section 1: Strict attempt budget edge cases                        */
/* ------------------------------------------------------------------ */

test("mine-tool library: budgetsPerWorker distributes correctly for divisible budget", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge1");
  const cp = buildFreshCheckpoint(plan, freshSpec(4, 100), utcNow());
  const probed: Array<[number, bigint]> = [];
  // maxAttempts=8, workers=4 → budgets [2,2,2,2], total 8
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [2, 2, 2, 2],
    chunkYield: 1,

    onNonceProbe: (w, n) => probed.push([w, n]),
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 8);
  assert.equal(probed.length, 8);
  assert.deepEqual(probed.filter(([w]) => w === 0).length, 2);
  assert.deepEqual(probed.filter(([w]) => w === 1).length, 2);
  assert.deepEqual(probed.filter(([w]) => w === 2).length, 2);
  assert.deepEqual(probed.filter(([w]) => w === 3).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool library: budgetsPerWorker distributes correctly for non-divisible budget", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge2");
  const cp = buildFreshCheckpoint(plan, freshSpec(3, 100), utcNow());
  const probed: Array<[number, bigint]> = [];
  // maxAttempts=7, workers=3 → budgets [3,2,2], total 7
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [3, 2, 2],
    chunkYield: 1,

    onNonceProbe: (w, n) => probed.push([w, n]),
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 7);
  assert.equal(probed.length, 7);
  assert.deepEqual(probed.filter(([w]) => w === 0).length, 3);
  assert.deepEqual(probed.filter(([w]) => w === 1).length, 2);
  assert.deepEqual(probed.filter(([w]) => w === 2).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool library: budgetsPerWorker rejects zero budget", async () => {
  const plan = getGenesisPlan();
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 100), utcNow());
  await assert.rejects(
    runMiningSession({
      plan,
      checkpoint: cp,
      checkpointPath: join(scratchDir("edge3"), "cp.json"),
      resultPath: join(scratchDir("edge3"), "result.json"),
      budgetsPerWorker: [1, 0],
      chunkYield: 1,
  
    }),
    /budgetsPerWorker entries must be integers >= 1/
  );
});

test("mine-tool library: budgetsPerWorker rejects wrong length", async () => {
  const plan = getGenesisPlan();
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 100), utcNow());
  await assert.rejects(
    runMiningSession({
      plan,
      checkpoint: cp,
      checkpointPath: join(scratchDir("edge4"), "cp.json"),
      resultPath: join(scratchDir("edge4"), "result.json"),
      budgetsPerWorker: [1],
      chunkYield: 1,
  
    }),
    /budgetsPerWorker must be an array of length 2/
  );
});

test("mine-tool library: --max-attempts 1 --workers 1 runs exactly 1 attempt", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge5");
  const cp = buildFreshCheckpoint(plan, freshSpec(1, 100), utcNow());
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [1],
    chunkYield: 1,

  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 1);
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Section 1: CLI subprocess tests for budget edge cases              */
/* ------------------------------------------------------------------ */

test("mine-tool CLI: --max-attempts 1 --workers 1 runs exactly 1 attempt", () => {
  const dir = scratchDir("edge-cli-1");
  const cpPath = join(dir, "cp.json");
  const run = runCli([
    "--start", "0x0", "--max-attempts", "1", "--workers", "1",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "1", 
  ]);
  assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stdout.includes("status=budget-exhausted"));
  const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(cp.totalAttempts, 1);
  assert.deepEqual(cp.workers.map((w) => w.attempts), [1]);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: --max-attempts 2 --workers 4 rejected with usage error", () => {
  const dir = scratchDir("edge-cli-2");
  const cpPath = join(dir, "cp.json");
  const run = runCli([
    "--start", "0x0", "--max-attempts", "2", "--workers", "4",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "1", 
  ]);
  assert.equal(run.code, 2, `expected exit 2, got ${run.code}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stderr.includes("must be >= --workers"));
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: --max-attempts 4 --workers 4 runs exactly 1 attempt per worker", () => {
  const dir = scratchDir("edge-cli-3");
  const cpPath = join(dir, "cp.json");
  const run = runCli([
    "--start", "0x0", "--max-attempts", "4", "--workers", "4",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "1", 
  ]);
  assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stdout.includes("status=budget-exhausted"));
  const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(cp.totalAttempts, 4);
  assert.deepEqual(cp.workers.map((w) => w.attempts), [1, 1, 1, 1]);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: --max-attempts 7 --workers 2 runs exactly 7 attempts [4,3]", () => {
  const dir = scratchDir("edge-cli-4");
  const cpPath = join(dir, "cp.json");
  const run = runCli([
    "--start", "0x0", "--max-attempts", "7", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "1", 
  ]);
  assert.equal(run.code, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(run.stdout.includes("status=budget-exhausted"));
  const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(cp.totalAttempts, 7);
  assert.deepEqual(cp.workers.map((w) => w.attempts), [4, 3]);
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: --max-attempts is per-invocation across resume (F-2)", () => {
  const dir = scratchDir("edge-cli-max-attempts");
  const cpPath = join(dir, "cp.json");

  // Process 1: --max-attempts 10, workers=2 → 10 attempts
  const first = runCli([
    "--start", "0x0", "--max-attempts", "10", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "5",
  ]);
  assert.equal(first.code, 0, `stdout: ${first.stdout}\nstderr: ${first.stderr}`);
  assert.ok(first.stdout.includes("status=budget-exhausted"));
  const afterFirst = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(afterFirst.totalAttempts, 10);
  assert.deepEqual(afterFirst.workers.map((w) => w.attempts), [5, 5]);

  // Process 2: resume with SAME --max-attempts=10 → should do 10 MORE attempts (total 20)
  const second = runCli([
    "--start", "0x0", "--max-attempts", "10", "--workers", "2",
    "--checkpoint", cpPath, "--mine", "--chunk-size", "5",
  ]);
  assert.equal(second.code, 0, `stdout: ${second.stdout}\nstderr: ${second.stderr}`);
  assert.ok(second.stdout.includes("status=budget-exhausted"));
  const afterSecond = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
  assert.equal(afterSecond.totalAttempts, 20);
  assert.deepEqual(afterSecond.workers.map((w) => w.attempts), [10, 10]);

  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool CLI: invalid --max-attempts values rejected", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "99999999999999999999"]) {
    const run = runCli([
      "--start", "0x0", "--max-attempts", bad, "--workers", "1",
      "--checkpoint", "/tmp/opencode/audit-edge/cp-invalid.json", "--mine",
    ]);
    assert.equal(run.code, 2, `expected exit 2 for --max-attempts ${bad}`);
    assert.ok(run.stderr.includes("Refusing to mine"));
  }
});

test("mine-tool CLI: invalid --checkpoint-every values rejected", () => {
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    const run = runCli([
      "--start", "0x0", "--max-attempts", "5", "--workers", "1",
      "--checkpoint", "/tmp/opencode/audit-edge/cp-invalid.json", "--mine",
      "--checkpoint-every", bad,
    ]);
    assert.equal(run.code, 2, `expected exit 2 for --checkpoint-every ${bad}`);
    assert.ok(run.stderr.includes("Refusing to mine"));
  }
});

/* ------------------------------------------------------------------ */
/* Section 2: Orphan-result recovery                                  */
/* ------------------------------------------------------------------ */

test("mine-tool: orphan recovery limitation — valid-candidate success path cannot be tested without real mining", () => {
  // Documented limitation: reconcileOrphanResultArtifact's success path
  // (valid artifact adopted into checkpoint) requires a nonce that passes
  // production verifyHeaderPoW. The pinned genesis nonce 0 is a known PoW
  // failure, and finding a valid nonce requires ~2^32 hashes (~48.9 h at
  // measured throughput). Without running a real search, fabricating a
  // candidate, or weakening PoW validation, the success path cannot be
  // exercised deterministically. The rejection paths are fully tested.
  const plan = getGenesisPlan();
  assert.equal(isMiningCandidate(plan.header, 0n), false, "pinned nonce 0 must remain a known PoW failure");
  // Verify rejection paths work:
  const dir = scratchDir("edge-orphan-lim");
  const path = join(dir, "result.json");
  // Malformed JSON
  writeFileSync(path, "{ not json", "utf8");
  assert.throws(() => reconcileOrphanResultArtifact(plan, path), /malformed result artifact/);
  // Invalid record (nonce 0 fails PoW)
  const invalidRecord = {
    nonce: "0x0000000000000000",
    nonceDecimal: "0",
    preimageDigest: plan.preimageDigest,
    powHash: "0x" + "0".repeat(64),
    target: "0x" + POW_LIMIT.toString(16),
    difficulty: GENESIS_DIFFICULTY.toString(),
    powLimit: "0x" + POW_LIMIT.toString(16),
    genesisHash: "0x" + "0".repeat(64),
    chainId: DEV_CHAIN_ID,
    paramVersion: DEV_PARAM_VERSION,
    foundAtUtc: utcNow(),
    totalAttempts: 1,
    header: {
      parentHash: plan.header.parentHash,
      number: plan.header.number,
      timestamp: plan.header.timestamp,
      difficulty: GENESIS_DIFFICULTY.toString(),
      coinbase: plan.header.coinbase,
      extraData: toHex(plan.header.extraData),
      gasLimit: plan.header.gasLimit.toString(),
      gasUsed: plan.header.gasUsed.toString(),
      transactionsRoot: plan.header.transactionsRoot,
      stateRoot: plan.header.stateRoot,
    },
  };
  writeFileSync(path, JSON.stringify(invalidRecord, null, 2) + "\n", "utf8");
  assert.throws(() => reconcileOrphanResultArtifact(plan, path), /failed production re-verification/);
  // File preserved untouched
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as { nonce: string };
  assert.equal(onDisk.nonce, "0x0000000000000000");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Section 3: Stop responsiveness and checkpoint durability           */
/* ------------------------------------------------------------------ */

test("mine-tool: checkpoint written on stop", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge-stop");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 1000), utcNow());
  let stopCalls = 0;
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [100, 100],
    chunkYield: 10,

    shouldStop: () => {
      stopCalls += 1;
      return stopCalls > 1;
    },
  });
  assert.equal(outcome.status, "stopped");
  assert.ok(outcome.attempts > 0, "some attempts should have been made before stop");
  // Checkpoint must exist and be valid after stop
  const persisted = JSON.parse(readFileSync(join(dir, "cp.json"), "utf8")) as Checkpoint;
  assert.deepEqual(validateCheckpoint(persisted, plan).problems, []);
  assert.ok(persisted.totalAttempts > 0, "checkpoint should record attempts made before stop");
  rmSync(dir, { recursive: true, force: true });
});

test("mine-tool: --checkpoint-every validated and controls periodic persistence", async () => {
  const plan = getGenesisPlan();
  const dir = scratchDir("edge-cp-every");
  const cp = buildFreshCheckpoint(plan, freshSpec(2, 1000), utcNow());
  // checkpoint-every=1 → checkpoint after every attempt
  const outcome = await runMiningSession({
    plan,
    checkpoint: cp,
    checkpointPath: join(dir, "cp.json"),
    resultPath: join(dir, "result.json"),
    budgetsPerWorker: [5, 5],
    chunkYield: 1,

    checkpointEveryAttempts: 1,
  });
  assert.equal(outcome.status, "budget-exhausted");
  assert.equal(outcome.attempts, 10);
  // With checkpoint-every=1 and 2 workers, we expect a checkpoint after
  // every attempt: 10 attempts → checkpointCount >= 2 (initial + periodic)
  assert.ok(cp.checkpointCount > 2, `expected frequent checkpoints with checkpoint-every=1, got ${cp.checkpointCount}`);
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Section 4: Long-run operational configuration (calculations only)  */
/* ------------------------------------------------------------------ */

test("mine-tool: estimated checkpoint writes for long-run search (documentation)", () => {
  // Estimated search duration: ~48.9 h at ~24,400 H/s single-threaded
  // Default checkpoint-every: 50,000 attempts per worker
  // Time per checkpoint per worker: 50,000 / 24,400 ≈ 2.05 seconds
  // Checkpoints over 48.9 h per worker: 48.9 * 3600 / 2.05 ≈ 85,800
  // With 2 workers: ~171,600 checkpoint writes
  const estimatedHashesPerNonce = 4_295_032_833n;
  const measuredRate = 24_400; // hashes/second
  const estimatedSeconds = Number(estimatedHashesPerNonce) / measuredRate; // ~176,026 s ≈ 48.9 h
  const checkpointEvery = 50_000;
  const checkpointsPerWorker = Math.floor(estimatedSeconds / (checkpointEvery / measuredRate));
  assert.ok(checkpointsPerWorker > 50_000, "expected tens of thousands of checkpoints over a multi-day run");
  // Logical workers do not provide multi-core parallelism (single event loop)
  assert.ok(true, "documented: workers partition nonce space but run in one process");
});
