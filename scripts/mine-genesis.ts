#!/usr/bin/env tsx
/**
 * CASHBI GENESIS POW MINER — bounded, resumable, checkpointed.
 *
 * SAFETY GATE: a nonce search NEVER starts unless ALL of
 *   --start <0x|dec>  --max-attempts <n>  --workers <n>  --checkpoint <path>
 * AND the explicit opt-in flag --mine are present on the command line.
 * With any argument missing (or without --mine) the script prints its
 * usage/current plan preview and exits WITHOUT hashing a single nonce.
 *
 * This is PREPARATION for a separately-authorized genesis re-mine. It does
 * not modify src/chain/genesis.ts, does not activate startup genesis PoW
 * validation, and does not change DEV_PARAM_VERSION. A discovered candidate
 * must be independently re-verified before activation (see
 * docs/genesis-mining.md and REPORT_GENESIS_MINING_TOOL.md).
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  allocateWindows,
  buildFreshCheckpoint,
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  getGenesisPlan,
  loadCheckpoint,
  parseCliArguments,
  runMiningSession,
  SessionOutcome,
  writeCheckpointAtomic,
} from "../src/tools/genesis-mining.js";
import { DEV_PARAM_VERSION, GENESIS_DIFFICULTY, POW_LIMIT } from "../src/config/params.js";
import type { PlanSpec } from "../src/tools/genesis-mining.js";

function usage(exitCode: number): never {
  process.stderr.write(
    [
      "Usage (SAFE — no hashing without --mine and every required argument):",
      "",
      "  npm run mine-genesis -- \\",
      "      --start 0x0                              # plan origin nonce (0x-hex or decimal)",
      "      --max-attempts 500000                    # attempts budget for THIS invocation",
      "      --workers 2                              # concurrent workers; ranges disjoint",
      "      --checkpoint /tmp/opencode/genesis-search/checkpoint.json",
      "      [--result /tmp/candidate-result.json]    # default <checkpoint>.result.json",
      "      [--chunk-size 1024] [--sleep-ms 1]       # batching / event-loop yield",
      "      [--checkpoint-every 50000]           # attempts per worker between checkpoints",
      "      --mine                                   # EXPLICIT opt-in; without it: plan preview only",
      "",
      "Without --mine, or with any required argument missing, this script",
      "performs NO nonce search and writes NO checkpoint.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function fail(message: string, exitCode: number): never {
  process.stderr.write(message + "\n");
  process.exit(exitCode);
}

function rowCount(n: bigint | number): string {
  return n.toString(10);
}

function main(): void {
  const parsedFlags = parseArgs({
    options: {
      mine: { type: "boolean", default: false },
      start: { type: "string" },
      "max-attempts": { type: "string" },
      workers: { type: "string" },
      checkpoint: { type: "string" },
      result: { type: "string" },
      "chunk-size": { type: "string" },
      "sleep-ms": { type: "string" },
      "checkpoint-every": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  const cli = parseCliArguments(parsedFlags.values as never);
  const plan = getGenesisPlan();

  // Banner is always printed; hashing is gated below.
  process.stdout.write(
    [
      "CASHBI GENESIS MINER — bounded, resumable, checkpointed",
      `preimage digest : ${plan.preimageDigest}`,
      `consensus       : chainId=${plan.config.chainId} difficulty=${GENESIS_DIFFICULTY} ` +
      `powLimit=0x${POW_LIMIT.toString(16).padStart(64, "0")} paramVersion=${DEV_PARAM_VERSION}`,
      "estimate        : ~(2^256)/(POW_LIMIT+1) = 4295032833 hashes per valid nonce",
      "                  (~48.9 h at the measured ~24,400 H/s single-thread rate; ESTIMATE)",
      "",
    ].join("\n"),
  );

  if (cli.mode === "usage") {
    process.stderr.write("Refusing to mine: " + cli.problems.join("; ") + "\n\n");
    usage(2);
  }

  const values = cli.values;
  const maxAttempts = values.maxAttempts!;
  const workers = values.workers!;
  // F-2: strict per-worker budgets that sum to exactly --max-attempts.
  // Each worker needs at least 1 attempt budget, so maxAttempts must be >= workers.
  if (maxAttempts < workers) {
    fail(
      `--max-attempts ${maxAttempts} must be >= --workers ${workers} (each worker needs at least 1 attempt budget)`,
      2,
    );
  }
  const baseBudget = Math.floor(maxAttempts / workers);
  const remainder = maxAttempts % workers;
  const budgetsPerWorker: number[] = [];
  for (let w = 0; w < workers; w++) {
    budgetsPerWorker.push(baseBudget + (w < remainder ? 1 : 0));
  }
  const spec: PlanSpec = {
    startNonce: values.startNonce!,
    workers,
    laneChunkSize: Math.ceil(maxAttempts / workers),
  };

  if (cli.mode === "plan" || parsedFlags.values["dry-run"] === true) {
    process.stdout.write("PLAN PREVIEW (dry run — nothing will be hashed, no files written)\n");
    for (const window of allocateWindows(spec, 0)) {
      process.stdout.write(
        `  worker ${window.worker} chunk ${window.chunkIndex}: ` +
        `[0x${window.fromNonce.toString(16)}, 0x${window.toNonce.toString(16)}] size=${rowCount(window.size)}\n`,
      );
    }
    process.stdout.write("Add --mine to hash within the stated per-invocation attempt budget.\n");
    process.exit(0);
  }

  // MODE mine: every required argument is present and --mine is given.
  const checkpointPath = values.checkpoint!;
  const resultPath = values.result ?? `${checkpointPath}.result.json`;
  if (!existsSync(dirname(checkpointPath))) {
    fail(`--checkpoint parent directory does not exist: ${dirname(checkpointPath)} (create it first)`, 2);
  }
  if (resultPath === checkpointPath) fail("--result must differ from --checkpoint", 2);

  let checkpoint;
  if (existsSync(checkpointPath)) {
    process.stdout.write(`resuming from checkpoint: ${checkpointPath}\n`);
    const loaded = loadCheckpoint(checkpointPath, plan);
    if (!loaded.ok) {
      fail(`ABORT — checkpoint rejected:\n${loaded.reason}`, 3);
    }
    checkpoint = loaded.checkpoint!;
    if (checkpoint.plan.workers !== values.workers) {
      fail(
        `ABORT — stored plan workers=${checkpoint.plan.workers} != invocation --workers=${values.workers}. ` +
        "Changing the worker strip invalidates lane mapping; use the original value.",
        3,
      );
    }
    const storedStart = BigInt(checkpoint.plan.startNonce);
    if (storedStart !== values.startNonce) {
      fail(
        `ABORT — stored plan startNonce ${checkpoint.plan.startNonce} != invocation --start 0x${values.startNonce!.toString(16)}`,
        3,
      );
    }
    spec.laneChunkSize = checkpoint.plan.laneChunkSize;
  } else {
    checkpoint = buildFreshCheckpoint(plan, spec, new Date().toISOString().replace("T", " ").replace("Z", ""));
    process.stdout.write(`new checkpoint: ${checkpointPath} (schema ${CHECKPOINT_SCHEMA} v${CHECKPOINT_VERSION})\n`);
    writeCheckpointAtomic(checkpointPath, checkpoint);
  }

  const checkpointEveryAttempts = values.checkpointEveryAttempts ?? 50_000;
  process.stdout.write(
    [
      "BOUNDED MINING RUN — this invocation hashes AT MOST",
      `  ${rowCount(maxAttempts)} nonces (${workers} workers; per-worker budgets ` +
      `sum to exactly ${maxAttempts}), then STOPS.`,
      "Earlier stop on a verified candidate or Ctrl+C (progress saved).",
      "Resume with identical arguments and a larger --max-attempts to continue.",
      "",
    ].join("\n"),
  );

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stdout.write("\nSIGINT received — finishing current batch, saving checkpoint, exiting…\n");
  });

  void runMiningSession({
    plan,
    checkpoint,
    checkpointPath,
    resultPath,
    budgetsPerWorker,
    chunkYield: values.chunkYield ?? 1024,
    sleepMs: values.sleepMs ?? 1,
    checkpointEveryAttempts,
    shouldStop: () => interrupted,
    onProgress: (info) => {
      const rate = info.elapsedSeconds > 0 ? (info.attempts / info.elapsedSeconds) : 0;
      process.stdout.write(
        `[progress] attempts=${info.attempts} rate=${rate.toFixed(0)}/s ` +
        `elapsed=${info.elapsedSeconds.toFixed(1)}s checkpointCount=${info.checkpointCount}\n`,
      );
    },
  })
    .then((outcome: SessionOutcome) => {
      process.stdout.write(
        [
          "",
          `status=${outcome.status} attempts=${outcome.attempts} rate=${outcome.rate.toFixed(0)}/s ` +
          `elapsed=${outcome.elapsedSeconds.toFixed(1)}s`,
          `checkpoint: ${checkpointPath}`,
        ].join("\n"),
      );
      if (outcome.status === "candidate-found" && outcome.candidate) {
        process.stdout.write(
          [
            "",
            "CANDIDATE FOUND — the record is UNVERIFIED until independently",
            "  re-verified per docs/genesis-mining.md (production re-derivation",
            "  executes here; independent verification is a separate step):",
            `  nonce            ${outcome.candidate.nonce} (dec ${outcome.candidate.nonceDecimal})`,
            `  powHash          ${outcome.candidate.powHash}`,
            `  target           ${outcome.candidate.target}`,
            `  genesisHash      ${outcome.candidate.genesisHash}`,
            `  result artifact  ${resultPath}`,
            "",
            "DO NOT pin this nonce in src/chain/genesis.ts and DO NOT activate startup",
            "genesis PoW validation until independent verification completes.",
          ].join("\n"),
        );
      } else if (outcome.status === "stopped") {
        process.stdout.write("\nInterrupted: checkpoint saved; resume with identical arguments.\n");
      } else if (outcome.status === "already-found") {
        process.stdout.write(
          "\nCheckpoint already holds a verified candidate — see the result artifact.\n",
        );
      } else {
        process.stdout.write("\nAttempt budget exhausted: resume with identical arguments and larger --max-attempts.\n");
      }
      process.exit(0);
    })
    .catch((err: Error) => {
      fail(`mining session failed: ${err.message}`, 1);
    });
}

main();
