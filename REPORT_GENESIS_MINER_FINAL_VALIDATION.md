# CashBI — Genesis Miner Multi-Process Cleanup & Audit Report

Repository: `/workspaces/codespaces-blank`
Task: `do.md` — "Final narrow audit and cleanup of the CashBI multi-process Genesis miner"
Date: 2026-10-30 · BASE: `HEAD 6e113cb682811a330fa14e9051018b46148c5d00` (== origin/main)

This is a read-only audit and bounded-test task per `do.md`. No real mining was started,
no consensus settings were changed, and no Git history operations were performed.
All changes are uncommitted as required.

---

## Finding 1: `--sleep-ms` option removal

### Problem
The `--sleep-ms` CLI option was parsed in `parseCliArguments` (`src/tools/genesis-mining.ts`)
and accepted in `scripts/mine-genesis.ts`, but it was **never passed to `runMiningSession`**
and **never used by the worker processes** (`src/tools/genesis-mining-worker.ts`).
Workers run at full speed with no throttling, so `--sleep-ms` was a no-op that
gave a false impression of throttle control.

### Fix
Removed `--sleep-ms` entirely from:
- `scripts/mine-genesis.ts`: removed from `parseArgs` options and usage text
- `src/tools/genesis-mining.ts`: removed from `CliFlags`, `ParsedCli.values`,
  and `parseCliArguments`
- `docs/genesis-mining.md`: removed from smoke test example, optional arguments
  list, and cost estimate note

### Backward compatibility
Not required. The tool is in preparation phase (no real mining performed, no
production deployments). Removing the option avoids documenting a no-op that
could mislead operators into thinking it throttles throughput.

### Test updates
Removed `sleepMs: 0` from all library test calls and `--sleep-ms 0` from all
CLI subprocess test invocations in `test/genesis-mining-tool.test.ts`. Renamed
two test names that referenced `--sleep-ms 0`:
- "SIGINT/stop responsive with --sleep-ms 0 (F-1)" → "SIGINT/stop responsive with Ctrl+C (F-1)"
- "checkpoint written on stop with --sleep-ms 0" → "checkpoint written on stop"

---

## Finding 2: `--max-attempts` semantics across checkpoint resumes

### Problem (correctness defect)
In `runMiningSession` (`src/tools/genesis-mining.ts`), the per-invocation budget
check compared **cumulative** attempts against the per-invocation budget:

```js
globalAttempts = baselineTotal + workerStates.reduce((sum, s) => sum + s.attemptedHere, 0);
if (globalAttempts >= maxAttempts && !stopped && !found) { ... }
```

`baselineTotal` is the sum of all worker attempts from the checkpoint (previous
invocations), and `maxAttempts` is the budget for **this invocation**. Comparing
cumulative against per-invocation meant that resuming with the same
`--max-attempts` as a previous run would immediately stop with 0 new attempts
(once `baselineTotal >= maxAttempts`). This is incorrect: `--max-attempts` is
documented as "this invocation hashes AT MOST N nonces."

### Fix
Changed the budget check to compare **session-only attempts** against
`maxAttempts`:

```js
const sessionAttempts = workerStates.reduce((sum, s) => sum + s.attemptedHere, 0);
globalAttempts = baselineTotal + sessionAttempts;
// ...
if (sessionAttempts >= maxAttempts && !stopped && !found) { ... }
```

`globalAttempts` (cumulative) is retained for checkpoint frequency and progress
display only — it is never compared against the budget.

### Documented semantics
Added to `docs/genesis-mining.md` under a new "Attempt budget semantics"
section:

> `--max-attempts <n>` sets a **per-invocation** attempt budget, not a cumulative
> limit across checkpoint history. Each invocation gets its own fresh budget of
> `n` attempts, distributed across workers... A resume invocation with the same
> `--max-attempts` will perform up to `n` additional attempts, regardless of
> how many attempts were recorded in previous invocations.
>
> The checkpoint's `totalAttempts` field records the cumulative sum across all
> invocations and is used only for record-keeping and re-verification — it is
> never compared against `--max-attempts`.

The CLI banner already correctly states "this invocation hashes AT MOST N nonces"
— this now matches the actual enforcement.

---

## Validation results

### Full test suite
```
npm test  →  157/157 pass  (~42 s)
```
(Was 154 tests; 3 new tests added for `--max-attempts` per-invocation semantics.)

### TypeScript typecheck
```
npx tsc --noEmit  →  clean
```

### Lint
```
npm run lint  →  clean (0 warnings)
```

### Security check
```
npm run security:check  →  clean (0 vulnerabilities)
```

### New tests added (3)

1. **`mine-tool library: --max-attempts is per-invocation across resume (F-2)`**
   Runs three consecutive invocations with `--max-attempts=10` on the same
   checkpoint. Verifies each invocation performs exactly 10 new attempts (not 0),
   and `totalAttempts` accumulates correctly (10, 20, 30).

2. **`mine-tool library: --max-attempts cannot be exceeded by any invocation (F-2)`**
   Runs invocations with budgets 5, 5, and 3 on the same checkpoint. Verifies
   each invocation performs exactly its configured budget (5, 5, 3) and never
   exceeds it. Cumulative total is accurate (13).

3. **`mine-tool CLI: --max-attempts is per-invocation across resume (F-2)`)**
   Subprocess test: two CLI invocations with `--max-attempts 10` on the same
   checkpoint. Verifies each invocation produces 10 attempts and
   `totalAttempts` reaches 20.

### Smoke test (manual)
```
Invocation 1: --max-attempts 40 → status=budget-exhausted attempts=40
Invocation 2: --max-attempts 40 (resume) → status=budget-exhausted attempts=40
Checkpoint: totalAttempts=80, worker0=40, worker1=40
```
Confirms each invocation does exactly 40 attempts, cumulative total is 80.

---

## Compliance confirmations

- **No real mining started** — all tests bounded; smoke test used 40–100 nonces
- **No consensus settings changed** — genesis nonce `0n`, `POW_LIMIT`, chain ID
  (901291), supply, rewards, `DEV_PARAM_VERSION` ("0.0.1-dev") all untouched
- **No production PoW bypass** — `verifyHeaderPoW` remains the sole authority
- **No Git history operations** — no commit, push, deploy, reset, stash, clean,
  or discard. Working tree changes are preserved
- **This report (`REPORT_GENESIS_MINER_FINAL_VALIDATION.md`) is uncommitted**,
  per `do.md` instructions

---

## Files changed

| File | Change |
|---|---|
| `src/tools/genesis-mining.ts` | Removed `sleepMs` from CLI interfaces/parsing; fixed `--max-attempts` per-invocation budget check (use session attempts, not cumulative) |
| `scripts/mine-genesis.ts` | Removed `--sleep-ms` from parseArgs options and usage text |
| `src/tools/genesis-mining-worker.ts` | No changes (never used sleepMs) |
| `docs/genesis-mining.md` | Removed `--sleep-ms` references; added "Attempt budget semantics" section documenting per-invocation behavior |
| `test/genesis-mining-tool.test.ts` | Removed all `sleepMs: 0` references; renamed two test names; added 3 new tests for `--max-attempts` per-invocation resume semantics |
| `REPORT_GENESIS_MINER_FINAL_VALIDATION.md` | **New** — this report (uncommitted) |
