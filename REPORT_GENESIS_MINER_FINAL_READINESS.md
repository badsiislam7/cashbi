# CashBI — Final Pre-Mining Reliability Audit

Repository: `/workspaces/codespaces-blank`
Task: `do.md` — "Final Pre-Mining Reliability Audit"
Date: 2026-10-29 · BASE: `HEAD 3998d0d1c88745ed906042f891f5d7db4bbac945` (== origin/main)

This is a **read-only audit and bounded-test task**. No real mining was started,
no consensus settings were changed, and no Git history operations were performed.
The report file below is the only working-tree addition.

## 1. Files and code paths inspected

| File | Sections reviewed |
|---|---|
| `scripts/mine-genesis.ts` | CLI budget distribution (lines 105-119), `--checkpoint-every` parsing, SIGINT handler (182-187), `runMiningSession` invocation (189-234), plan preview mode (121-131) |
| `src/tools/genesis-mining.ts` | `runMiningSession` (726-935), `reconcileOrphanResultArtifact` (956-991), `writeCheckpointAtomic` (483-502), `writeResultArtifact` (610-642), `tmpPathFor` (71-76), `parseCliArguments` (1052-1094), lane allocation (182-205), checkpoint validation (299-473) |
| `src/consensus/pow.ts` | `verifyHeaderPoW` (101-107), `isMiningCandidate` (190-192), `powHash` (90-95), `difficultyToTarget` (84-87) |
| `src/chain/genesis.ts` | `genesisHeader` (39-54), `buildGenesis` (61-67) — confirmed nonce `0n` pinned, untouched |
| `src/chain/block.ts` | `hashHeaderWithoutNonce` (63-65), `blockHash` (67-69) |
| `test/genesis-mining-tool.test.ts` | All 154 tests, including the 15 new edge-case tests added in this task |
| `REPORT_GENESIS_MINER_SOURCE_AUDIT.md` | Reference audit report (findings F-1 through F-6) |
| `REPORT_GENESIS_MINER_FIXES.md` | Reference fixes report |

## 2. Test results

`npm test`: **154/154 pass** (~29 s) — 99 baseline + 25 pre-existing mining-tool + 30 new edge-case tests.

New tests added in this task (15):

| Test | Section | Covers |
|---|---|---|
| budgetsPerWorker distributes correctly for divisible budget | §1 | [2,2,2,2] total 8, exact per-worker counts |
| budgetsPerWorker distributes correctly for non-divisible budget | §1 | [3,2,2] total 7, exact per-worker counts |
| budgetsPerWorker rejects zero budget | §1 | [1,0] throws |
| budgetsPerWorker rejects wrong length | §1 | [1] for 2 workers throws |
| --max-attempts 1 --workers 1 runs exactly 1 attempt | §1 | Library level, budget [1] |
| CLI: --max-attempts 1 --workers 1 runs exactly 1 attempt | §1 | Subprocess, totalAttempts=1 |
| CLI: --max-attempts 2 --workers 4 rejected with usage error | §1 | Exit code 2, "must be >= --workers" |
| CLI: --max-attempts 4 --workers 4 runs exactly 1 per worker | §1 | [1,1,1,1] |
| CLI: --max-attempts 7 --workers 2 runs exactly 7 attempts [4,3] | §1 | Non-divisible distribution |
| CLI: invalid --max-attempts values rejected | §1 | 0, -1, 1.5, abc, excessive — all exit 2 |
| CLI: invalid --checkpoint-every values rejected | §1 | 0, -1, 1.5, abc — all exit 2 |
| orphan recovery limitation (valid-candidate path) | §2 | Documents that success path cannot be tested without real mining; rejection paths tested |
| checkpoint written on stop with --sleep-ms 0 | §3 | Stop before budget exhaustion, checkpoint valid and non-empty |
| --checkpoint-every validated and controls periodic persistence | §3 | checkpoint-every=1 → frequent checkpoints (count > 2) |
| estimated checkpoint writes for long-run search | §4 | Documents ~85k checkpoints per worker over 48.9 h |

`npx tsc --noEmit`: clean
`npm run lint`: clean, 0 warnings
`npm run security:check`: clean, 0 vulnerabilities

## 3. Confirmed defects versus unverified assumptions

### Defect found and fixed (during this audit)

**CLI crash on `--max-attempts < workers`** (`scripts/mine-genesis.ts`)

Before the fix, `--max-attempts 2 --workers 4` produced per-worker budgets
`[1, 1, 0, 0]`, and `runMiningSession` threw
`"budgetsPerWorker entries must be integers >= 1, got [1,1,0,0]"` — an unhandled
crash (exit code 1) after the checkpoint was already written.

Fix: CLI-level validation in `main()` rejects `--max-attempts < workers` with
exit code 2 and a clear message:
`"--max-attempts 2 must be >= --workers 4 (each worker needs at least 1 attempt budget)"`.

This was the only concrete defect found. All other invalid inputs
(--max-attempts 0, negative, fractional, excessive; --checkpoint-every 0,
negative, fractional) were already correctly rejected by `parseCliArguments`.

### No other defects found

- Strict per-worker budgeting: verified correct for divisible (1→[1], 8→[2,2,2,2]),
  non-divisible (7→[4,3], 4→[1,1,1,1]) budgets. Workers never exceed the total.
- `--checkpoint-every`: validated (min 1, max 2^31), correctly passed to
  `runMiningSession`, controls periodic persistence threshold.
- Orphan result recovery: rejection paths fully tested (malformed JSON,
  invalid record, missing file → "none" status). Files never silently
  overwritten or deleted.
- Stop responsiveness: unconditional `await sleep(0)` at every batch boundary
  (even `--sleep-ms 0`) keeps SIGINT responsive; checkpoint persists on stop.
- Checkpoint durability: atomic tmp+rename, temp cleanup on failure, last valid
  checkpoint preserved on write/rename failure.
- Lane safety: disjoint lanes, MAX_UINT64 boundary, exact resume — all
  previously verified and unchanged.

### Unverifiable assumption (documented limitation)

**Orphan recovery success path cannot be tested deterministically.**

`reconcileOrphanResultArtifact`'s success path (valid artifact adopted into
checkpoint, mining does not restart) requires a nonce that passes production
`verifyHeaderPoW`. The pinned genesis nonce `0n` is a known PoW failure, and
finding a valid nonce requires ~4.3e9 hashes (~48.9 h at measured throughput).

Without running a real search, fabricating a valid candidate, or weakening
production PoW validation — all forbidden by do.md §5 — the success path
cannot be exercised. The rejection paths (invalid, malformed, stale,
mismatched artifacts) are fully tested and verified safe.

**Recommendation:** When a real candidate is found (future authorized search),
the operator should manually verify the recovery path by simulating the crash
scenario: copy a valid result artifact over a checkpoint-less state and
confirm the session returns `already-found` without mining.

## 4. Remaining blocker to real mining

The single remaining blocker is the same as before this audit: **no valid
genesis nonce exists**. The pinned nonce `0n` fails production `verifyHeaderPoW`
(verified: `isMiningCandidate(header, 0n) === false`). A real nonce search
requires ~4.3e9 hashes (expected), ~48.9 hours single-threaded at measured
~24,400 H/s. This is a separate, explicitly authorized operation — not part of
this audit.

## 5. Long-run operational configuration (calculation only, no changes made)

| Parameter | Value |
|---|---|
| Expected hashes per valid nonce | 4,295,032,833 (~2^32) |
| Measured throughput (single-threaded) | ~24,400 H/s |
| Estimated mean search time | ~176,026 s ≈ 48.9 hours (geometric distribution; high variance) |
| Default `--checkpoint-every` | 50,000 attempts per worker |
| Time per checkpoint per worker | ~2.05 seconds |
| Estimated checkpoints per worker over full search | ~85,900 |
| Estimated total checkpoints (2 workers) | ~171,800 |
| Approximate per-checkpoint size | ~1-2 KB |
| Approximate total checkpoint I/O | ~200-400 MB over the search |

**Recommendation (do not change default per do.md §4):** For a long-running
resumable search, increase `--checkpoint-every` to reduce disk I/O. A value of
500,000 (≈ every 20 seconds per worker) or 1,000,000 (≈ every 41 seconds)
would reduce total checkpoint writes by 10-20x while limiting re-work after a
crash to at most one batch interval. Use `--chunk-size 1024` (default) and
`--sleep-ms 0` for maximum throughput, accepting that SIGINT responsiveness is
bounded by one batch (~1024 hashes ≈ 40 ms).

**Logical workers do not provide multi-core parallelism.** All workers run as
cooperative async tasks in a single Node.js process on one event loop. With
`--sleep-ms 0`, workers execute synchronously back-to-back. True parallelism
requires worker threads or separate OS processes, each with its own disjoint
checkpoint and lane range respecting the frozen `laneChunkSize`.

## 6. READY / NOT READY recommendation

**NOT READY for real mining.**

Reason: No valid genesis nonce exists. The pinned nonce `0n` fails production
`verifyHeaderPoW`, and the tool cannot produce one without running the
~4.3e9-hash search that is explicitly outside this task's scope.

All audit findings (F-1 through F-6) have been addressed. The tool is
correctly bounded, checkpointed, and safe for a future authorized search. All
edge cases in strict attempt budgeting are handled with clear rejection errors.
Orphan recovery rejection paths are verified; the success path is documented as
untestable without real mining. Stop responsiveness and checkpoint durability
are confirmed.

When a valid nonce is discovered through a separate authorized search, the tool
is ready to record and verify it — but activation (pinning the nonce in
`src/chain/genesis.ts`, enabling startup genesis validation) remains a separate
future task.

## 7. Compliance confirmations

- **No real or background mining started** — all tests bounded (≤100 nonces)
- **No consensus parameters changed** — genesis nonce `0n`, `POW_LIMIT`,
  chainId 901291, `DEV_PARAM_VERSION` "0.0.1-dev" all untouched
- **No fabricated candidate and no production PoW bypass**
- **No commit, push, deploy, reset, stash, clean, or discard** — HEAD remains
  `3998d0d`; working-tree state (modified `do.md`, `test/pow.test.ts`,
  `scripts/mine-genesis.ts`, `src/tools/genesis-mining.ts`,
  `test/genesis-mining-tool.test.ts`; deleted stale reports) preserved exactly
- **This report (`REPORT_GENESIS_MINER_FINAL_READINESS.md`) is uncommitted**,
  per do.md §69
