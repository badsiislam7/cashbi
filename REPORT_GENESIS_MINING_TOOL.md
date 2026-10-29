# Report — Prepare a Resumable Genesis PoW Mining Tool (Preparation Only)

Task source: `do.md` ("Prepare a Resumable Genesis PoW Mining Tool"). Date: 2026-10-29.
Base: `HEAD c27d4a1` (= `origin/main`), repo `badsiislam7/cashbi`.

## Files changed (exact)

| File | Change |
|---|---|
| `src/tools/genesis-mining.ts` | **new** — mining-tool library: lane allocation, plan/preimage loader, checkpoint build/validate/atomic-IO, candidate verification via production functions, bounded session runner, shared CLI gate. |
| `scripts/mine-genesis.ts` | **new** — thin CLI wrapper: usage/dry-run/mine modes, resume validation and aborts, SIGINT handling, progress output, candidate report. |
| `test/genesis-mining-tool.test.ts` | **new** — 25 bounded, deterministic tests (see below). |
| `docs/genesis-mining.md` | **new** — operational documentation per task §7. |
| `package.json` | added `"mine-genesis": "tsx scripts/mine-genesis.ts"` script. |
| `REPORT_GENESIS_MINING_TOOL.md` | **new** — this report. |

Not changed: `src/chain/genesis.ts` (nonce still `0n`, untouched), all consensus
code (`src/consensus/pow.ts`, `src/config/params.ts`, `src/chain/block.ts`),
`DEV_PARAM_VERSION`, chain ID, `POW_LIMIT`. No commits or pushes were made; no
git history operations of any kind were performed. Working-tree state (modified
`do.md`, modified `test/pow.test.ts`, deleted stale REPORT_*.md files from the
prior environment) was preserved exactly as required.

## CLI interface and safe invocation

```
npm run mine-genesis -- --start 0x0 --max-attempts <n> --workers <n> --checkpoint <path> [--result <path>] [--chunk-size n] [--sleep-ms n] --mine
```

- **Safe exit guarantee:** without `--mine`, or with any required argument
  missing/bad, the script prints usage (and, on `--dry-run`, a plan preview
  showing the workers' chunk windows) and exits with code 2 **without hashing a
  single nonce and without writing any file**. The gate lives in the shared
  `parseCliArguments` in the library so tests can exercise it without spawning
  processes.
- Banner always printed (no hashing): preimage digest
  `0xcec2e2826d5cd253442799f2d55fec9bf3264d9d772328de250624e126983209`,
  chainId 901291, difficulty 1, `POW_LIMIT 0x00000000ffff0000…0000`,
  `paramVersion 0.0.1-dev`, and the hash-count estimate
  (4,295,032,833 hashes ≈ 2^256/(POW_LIMIT+1), ~48.9 h single-threaded,
  labeled ESTIMATE, from the previously measured ~24,400 H/s powHash rate).
- Exit codes: 0 success · 2 usage · 3 invalid checkpoint / plan mismatch
  (abort, file untouched) · 1 runtime error · 130 SIGINT.
- Resume requires identical `--start` and `--workers` (else abort with exit 3);
  `--max-attempts` is a fresh per-invocation budget. README-level docs:
  `docs/genesis-mining.md`.

## Design: lanes, checkpoints, candidates

- **Lane model:** worker `w` owns chunks `[start + (k·workers + w)·laneChunkSize, …)` —
  globally disjoint lanes with contiguous per-wave coverage. Windows clamp to
  `MAX_UINT64`; a worker whose next own chunk starts past `2^64−1` is marked
  `exhausted` in the checkpoint and does no further work.
- **Exact resume:** each worker persists its `nextNonce` (position inside its
  own lane) and own-chunk index; on chunk completion it jumps to the **next
  own-lane chunk** start (never walking through another worker's lane). Check
  identity: `(n − start)/laneChunkSize % workers === w` determines ownership.
- **Checkpoint:** `cashbi-genesis-mining-checkpoint` v1 JSON with schema/
  version, genesis identity block (preimage digest, chainId, difficulty,
  powLimit, block time, retarget interval, paramVersion), plan (start, workers,
  frozen laneChunkSize), per-worker state, `totalAttempts`, checkpoint count,
  candidate record. Written atomically (temp file + rename). Full validation on
  load rejects schema/version drift, preimage drift (stale checkpoints from a
  different genesis config), consensus-constant mismatch, worker ranges outside
  their own lane or chunk window, duplicate/unknown worker ids, attempt-sum
  mismatch, and malformed candidate records. Malformed JSON refuses to
  silent-reset (operator must consciously move/delete the file). No secrets are
  stored in checkpoints.
- **Candidate verification:** the per-nonce target test is the production
  `isMiningCandidate`; a candidate is untrusted until re-verified through the
  production `verifyHeaderPoW`, the genesis hash re-derived via production
  `blockHash`, and the preimage digest cross-checked. The record is written
  FIRST to the result artifact (atomic, refuses to overwrite different existing
  content), then into the checkpoint. Any later resume re-verifies a recorded
  candidate through the same production path and hard-fails on mismatch.
- The tool reuses production functions; it duplicates no consensus algorithm
  and introduces no PoW bypass.

## Bugs found and fixed during this task

1. `1 << 31` JS bitwise sign bug in `MAX_ATTEMPTS_PER_INVOCATION` (became
   −2147483648, rejecting every `--max-attempts`) → `2 ** 31`.
2. `tryParseNonce` used `fromHex` (rejects odd-length hex such as `0x0`) →
   direct `BigInt` parse for checkpoint nonce strings.
3. **Lane-walk-through bug (design-level):** after finishing its own chunk, a
   worker's `nextNonce` walked linearly into the *next worker's lane*, which
   would have violated lane disjointness and crashed resume validation. Fixed:
   workers now jump to their next own-lane chunk at chunk completion, remaining
   provably inside their lane.
4. Missing `runMiningSession` import in the CLI (crash on `--mine`).
5. `powLimit` banner padded to 64 hex chars for readability.

## Tests added (25, all deterministic and bounded)

`test/genesis-mining-tool.test.ts`:

1. lanes disjoint + jointly cover their wave interval (4 workers, exhaustive set check);
2. `workerChunkStart` owned-lane grid formula (incl. invalid worker/chunk throws);
3. chunk windows clamp to `MAX_UINT64`, size 0 past it;
4. exhaustive disjointness over a wide plan spanning `MAX_UINT64` (every nonce owned at most once; `MAX_UINT64` owned by exactly one clamped lane);
5. CLI gate: missing args → usage, never a search;
6. CLI gate: complete args without `--mine` → plan mode only; `--mine` with bad numerics/out-of-range start → usage;
7. plan loader keeps pinned genesis nonce `0n` untouched;
8. fresh checkpoint builds (schema/version/genesis identity block), loads, round-trips, atomic writes leave no `.tmp-` residue;
9. tampered `nextNonce` outside the worker's own lane rejected;
10. tampered `nextNonce` past the chunk window rejected (by the disjoint-lane guard);
11. `totalAttempts` ≠ Σ worker attempts rejected;
12. checkpoint from a **different genesis preimage** rejected ("stale checkpoint");
13. changed consensus constants (`powLimit`, `paramVersion`) in an old checkpoint rejected;
14. malformed checkpoint JSON refuses to silent-reset, file never deleted/repaired;
15. `exhausted` worker validation (final clamped chunk) incl. rejecting a lying exhausted marker;
16. bounded session stops at budget with exact per-worker counts and exact probe sets (`onNonceProbe` hook: worker 0 probed [0,25), worker 1 [25,50));
17. resume is exact — zero reprocessing across invocations (probed nonces start exactly where the previous invocation stopped: 4,5,6 / 14,15,16);
18. lane exhaustion near `MAX_UINT64` marks workers `exhausted`, persists valid nonces (11 attempts total), persisted checkpoint revalidates, second session hashes 0;
19. `shouldStop` halts between batches, status `stopped`;
20. candidate verification runs the **production** `verifyHeaderPoW` (pinned nonce 0 is a known failure there; tool rejects it through the same code path, `preimageDigest` unaffected by nonce mutation);
21. a recorded candidate failing production re-verification **halts** the session with a hard error naming the production validator;
22. result artifact writer: atomic create, identical-content idempotence, refuses to overwrite different content, original preserved;
23. CLI (subprocess): no args → exit 2, usage printed, NO checkpoint file created;
24. CLI (subprocess): dry-run plan preview writes nothing and shows disjoint worker ranges;
25. CLI (subprocess): bounded `--mine` fresh run (40 attempts) then **exact resume in a second process** (80 total attempts, correct own-lane chunk jumps 0x28/0x3c → 0x50/0x64, `candidate: null` — no fabricated result).

No real nonce search: every hashing invocation is ≤ 50 nonces; subprocess tests
use explicit tiny attempt limits; no valid nonce fixture was invented.

## Validation results

- `npm test`: **124/124 pass** (99 baseline + 25 new), ~17.5 s.
- `npx tsc --noEmit`: clean.
- `npm run lint` (`eslint .`): clean, 0 warnings.
- `npm run security:check` (security:audit + lint + typecheck): clean.
- CLI smoke tests (manual, bounded): fresh run (50 attempts / 2 workers),
  resume run (60 more, total 110, positions 0x69/0x82 at own chunks), no-args
  refusal, dry-run preview — all behaved as specified.

## Checkpoint integrity / candidate verification recap

See "Design" above; operational details in `docs/genesis-mining.md`
(checkpoint/resume, Codespaces stop/resume, cost estimate labeled ESTIMATE,
independent verification procedure before activation, archive-old-datadirs
requirement, why pinning/validation must wait).

## Limitations / unresolved

- Single-process hashing (no worker threads/processes): throughput is bounded
  by one core (~24.4k H/s measured). The lane model supports any worker count,
  but the current runner executes all logical workers inside one process;
  process/thread-level scale-out would be a future extension (it must respect
  the frozen `laneChunkSize` in existing checkpoints).
- The "valid candidate accepted end-to-end" path cannot be exercised without a
  real valid nonce (mean ~4.3e9 hashes) — proven structurally instead:
  production-validator identity plus hard-fail on any failing recorded
  candidate.
- `attempts` counters can slightly over-count a batch that was re-hashed after
  a kill between checkpoint writes (coverage never gaps, lanes never overlap).
- Real genesis search (~4,295,032,833 expected hashes; ≈48.9 h single-thread,
  ESTIMATE) remains **strictly outside this task** and awaits explicit
  authorization. Valid-PoW acceptance via production `acceptBlock()`/P2P
  propagation likewise awaits that nonce.
- Initial reward / halving schedule remain undecided (as recorded previously).

## Compliance confirmations

- **No real nonce search was started** — neither by tests, nor by package
  scripts, nor manually; only bounded smoke runs of ≤ 60 nonces.
- **No consensus parameters changed**: `POW_LIMIT`, difficulty rules, chain ID
  (901291), supply, rewards, `DEV_PARAM_VERSION` ("0.0.1-dev"), handshake, and
  the pinned genesis nonce (`0n` in `src/chain/genesis.ts`) are untouched. No
  candidate nonce is pinned anywhere.
- **No Git history operations**: no commits, pushes, stashes, resets, cleans,
  or checkouts. Working tree preserved (`do.md` modified, `test/pow.test.ts`
  modified, stale report deletions preserved).
- No secrets or credentials embedded in checkpoints, scripts, or docs.
