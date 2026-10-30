# CashBI — Genesis Miner Multi-Core Parallelism Implementation

Repository: `/workspaces/codespaces-blank`
Task: `do.md` — "Implement true multi-core parallelism for the existing CashBI Genesis nonce mining tool"
Date: 2026-10-30 · BASE: `HEAD 09ea0a7bedba87f23e3ab8437a9e57d93a486610` (== origin/main)

## Summary

Implemented true multi-core parallelism for the CashBI Genesis PoW miner by replacing the single-process cooperative async worker model with **separate worker processes** spawned via `child_process.fork`. Each worker runs in its own OS process with its own V8 isolate, enabling genuine multi-core hash parallelism. The main thread remains the sole coordinator: it owns checkpoint writes, candidate verification, and the strict global attempt budget.

**No real mining was started.** No consensus settings were changed. No Git history operations were performed. This report is uncommitted.

## Files changed

| File | Change |
|---|---|
| `src/tools/genesis-mining.ts` | Rewrote `runMiningSession` to spawn one `child_process.fork` worker per logical worker. Main thread owns checkpoint persistence, candidate verification (`verifyHeaderPoW` + `blockHash`), global budget enforcement, and SIGINT handling. Added `serializeWorkerData()` helper for JSON transport of BigInt values via `MINING_WORKER_DATA` env var. Removed `sleepMs` option (no longer needed — workers run in separate processes). |
| `src/tools/genesis-mining-worker.ts` | **New file.** Worker process entry point. Imports only `isMiningCandidate` from production consensus code. Hashes a disjoint nonce lane, reports progress/candidates via IPC `process.send`. Never writes files. Receives init data via `MINING_WORKER_DATA` env var (BigInts serialized as hex strings). Handles `stop` IPC messages for graceful shutdown. |
| `scripts/mine-genesis.ts` | Removed inline SIGINT handler (now handled by `runMiningSession`). Removed `sleepMs` from runner options. CLI interface unchanged: `--start`, `--max-attempts`, `--workers`, `--checkpoint`, `--result`, `--chunk-size`, `--sleep-ms` (accepted but unused), `--checkpoint-every`, `--mine`, `--dry-run`. |
| `test/genesis-mining-tool.test.ts` | All 55 existing tests updated for worker-process architecture. New tests cover: divisible/non-divisible budget distribution, CLI rejection of `--max-attempts < workers`, CLI validation of invalid numeric args, `--checkpoint-every` propagation, stop responsiveness, checkpoint durability on stop, orphan artifact recovery, competing candidates. |

## Design

### Worker process model
- `runMiningSession` forks one child process per logical worker via `child_process.fork(workerPath, [], { execArgv: ["--import", "tsx"], env: { MINING_WORKER_DATA: ... } })`.
- Each worker gets its own disjoint lane via the existing grid formula: worker `w` owns chunks `[start + (k·workers + w)·laneChunkSize, … + laneChunkSize)`. Lanes are provably disjoint and contiguously covering.
- Workers run in separate V8 isolates on separate OS threads → genuine multi-core parallelism (2 CPUs available on this machine).
- Workers never write files. All checkpoint and result writes are coordinated by the main thread through `writeCheckpointAtomic` (temp file + rename).

### Global attempt budget (F-2)
- CLI distributes `--max-attempts` across workers: `baseBudget = floor(maxAttempts/workers)`, first `maxAttempts % workers` workers get `baseBudget + 1`. Sum equals exactly `--max-attempts`.
- `--max-attempts < workers` is rejected with exit code 2 and a clear error message.
- Main thread tracks `globalAttempts = baselineTotal + Σ worker.attemptedHere` and stops all workers when `globalAttempts >= maxAttempts`.

### Candidate integrity
- Worker detects target-passing nonce via production `isMiningCandidate`, sends `candidate` IPC message to main thread.
- Main thread re-verifies through production `verifyHeaderPoW` + `blockHash` + preimage cross-check before writing anything.
- Result artifact written first (atomic, refuses overwrite of different content), then checkpoint records candidate.
- Competing candidates: if two workers find different valid nonces in the same batch, the existing artifact is production-verified before deciding; valid existing candidates are preserved.

### Checkpoint durability
- Atomic temp-file + rename writes. Temp files use unique names (pid + counter) and are cleaned up on failure.
- Checkpoint written at: session start, periodic intervals (`--checkpoint-every`), budget exhaustion, lane completion, candidate discovery, and stop.
- On stop: all workers receive `stop` IPC, finish current batch, then session persists and resolves.
- Malformed/tampered checkpoints are rejected and never silently reset.

### Stop responsiveness (F-1)
- `setImmediate`-based `shouldStop` polling on the main thread (started after workers begin processing) ensures SIGINT is responsive even with `--sleep-ms 0` (which is now unused).
- Workers check `stop` flag between batches.
- Second SIGINT exits with code 130.

### CLI safety gate (unchanged)
- No mining without `--mine` and all required arguments.
- Missing/malformed arguments → exit code 2, usage printed, no files written.
- `--dry-run` / plan preview mode shows disjoint lanes without hashing.

## Tests run

| Suite | Result |
|---|---|
| `npm test` | **154/154 pass** (99 baseline + 55 mining tool tests), ~37 s |
| `npx tsc --noEmit` | Clean |
| `npm run lint` | Clean (0 errors, 0 warnings) |
| `npm run security:check` | Clean (0 vulnerabilities) |

### New tests added (in this task)
All 55 mining-tool tests were rewritten for the worker-process architecture. Key test coverage:

- **Disjoint nonce allocation:** exhaustive set-based coverage check across all lanes, `MAX_UINT64` boundary clamping, worker grid formula verification.
- **Strict global attempt budget:** divisible (8→[2,2,2,2]) and non-divisible (7→[4,3]) budgets verified at both library and CLI level.
- **CLI edge cases:** `--max-attempts 1 --workers 1`, `--max-attempts 2 --workers 4` (rejected), `--max-attempts 4 --workers 4` (1 per worker), invalid numerics (0, negative, fractional, excessive).
- **Worker coordination:** checkpoint written on stop, `--checkpoint-every` controls periodic persistence, resume is exact (zero reprocessing).
- **Worker failure:** `shouldStop` halts between batches; invalid orphan artifacts rejected safely; competing candidate with invalid existing artifact fails safely.
- **No real mining:** every test bounded to ≤200 nonces; no valid nonce fixture fabricated.

## Verified properties

1. **Multi-core parallelism:** workers run in separate OS processes via `child_process.fork`; each has its own V8 isolate.
2. **Disjoint lanes:** every nonce assigned to exactly one worker; workers never probe another's nonce; `MAX_UINT64` boundary tested without wraparound.
3. **Strict global budget:** workers never collectively exceed `--max-attempts`; non-divisible budgets distribute correctly.
4. **Checkpoint integrity:** atomic writes, no silent reset on corruption, schema/version/preimage/consensus-constant validation, attempt-count-sum integrity.
5. **Candidate integrity:** production `verifyHeaderPoW` is authoritative; block hash recomputed from exact candidate header; stale/edited result artifacts rejected; no invalid candidate triggers activation.
6. **CLI safety:** no mining without `--mine` + complete args; missing arguments → exit 2, no files written.
7. **Stop responsiveness:** SIGINT handled gracefully; checkpoint saved on stop; second SIGINT → exit 130.
8. **Resume:** exact next-nonce continuity, zero reprocessing, frozen `laneChunkSize` and plan parameters validated on resume.

## Remaining risks / limitations

- **Single-node parallelism only:** worker processes are on the same machine. Cross-machine distribution is not supported and would require a different architecture.
- **Worker process overhead:** each worker is a full Node.js process (~30-50 MB RSS). With `--workers 64` (max), memory usage scales linearly. For CPU-bound PoW hashing, optimal worker count ≈ number of CPU cores.
- **No valid nonce exists yet:** the pinned genesis nonce `0n` fails production `verifyHeaderPoW`. A real search requires ~4.3e9 expected hashes (~48.9 h single-threaded at measured throughput; roughly halved with 2 workers on separate cores). This remains a separate, explicitly authorized operation.
- **Orphan recovery success path untested:** adopting a valid orphan artifact into the checkpoint requires a real valid nonce, which cannot be fabricated without running a real search or weakening PoW validation (both forbidden). Rejection paths are fully tested.
- **`--sleep-ms` accepted but unused:** kept in CLI for backward compatibility; workers run in separate processes so sleep is unnecessary.

## Remaining blocker to real mining

No valid genesis nonce exists. The pinned nonce `0n` fails `verifyHeaderPoW`. Real mining requires a separately-authorized search with bounded invocations chained through checkpoints.

## Bounded smoke test command (future use)

```bash
mkdir -p /tmp/opencode/genesis-smoke
npm run mine-genesis -- \
  --start 0x0 \
  --max-attempts 100 \
  --workers 2 \
  --checkpoint /tmp/opencode/genesis-smoke/cp.json \
  --mine --chunk-size 10 --sleep-ms 0 --checkpoint-every 10
```

This hashes **at most 100 nonces** (2 workers × 50 each), writes a checkpoint, and stops. Takes well under a second. No real mining — no valid nonce exists, and none will be found at this scale.

## Compliance confirmations

- **No real or background mining started** — all tests bounded; smoke test uses 100 nonces.
- **No consensus settings changed** — `src/chain/genesis.ts` (nonce `0n`), `src/consensus/pow.ts`, `POW_LIMIT`, chain ID (901291), supply, rewards, `DEV_PARAM_VERSION` ("0.0.1-dev") all untouched.
- **No fabricated candidate and no production PoW bypass** — production `verifyHeaderPoW` remains the sole authority.
- **No Git history operations** — no commit, push, deploy, reset, stash, clean, or discard. Pre-existing working-tree state preserved.
- **This report (`REPORT_GENESIS_MINER_PARALLELISM.md`) is uncommitted**, per task instructions.
