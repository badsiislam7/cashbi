# CashBI Genesis Search — Non-Intrusive Live Status Check

Repository: `/workspaces/codespaces-blank`
Task: `do.md` — "Genesis Search — Non-Intrusive Live Status Check"
Inspection performed: 2026-10-31 09:57–09:58 UTC
**Verdict: HEALTHY** — evidence below. The search was not touched; every action
in this iteration was read-only (`ps`, `tail`, `grep`, `ls`, `stat`, JSON read).

---

## 1. Supervision & Process Tree

The supervisor process is **alive**:

```
PID 5947 (ppid 2150)  bash /workspaces/codespaces-blank/.work/genesis-search/run-search.sh
  started Sat Oct 31 09:39:25 2026, state S (sleeping between invocations is the
  normal state; S during an active invocation = waiting on the miner)
```

The auto-resume loop is **actively running invocation #3**:

```
invocation#1 exit=0  @ 09:48:26 UTC   (10M-attempt budget exhausted cleanly)
invocation#2 exit=0  @ 09:57:14 UTC   (10M-attempt budget exhausted cleanly)
invocation#3 started @ 09:57:14 UTC   (relaunched within the same second — no gap)
```

Process tree of invocation #3 (PID group 17372/17383/17384/17395 + two workers):

```
17372  npm run mine-genesis  (per-invocation: --max-attempts 10000000)
17395  tsx scripts/mine-genesis.ts          state R
17402  genesis-mining-worker.ts (worker 0)  state R
17403  genesis-mining-worker.ts (worker 1)  state R
```

**2. Mining loop state: RUNNING an invocation** (started 09:57:14, ~45 s of
warm-up observed; the between-invocation pause that existed at 09:57:14 was
closed immediately by the loop).

**3. Worker processes: BOTH ALIVE AND ACTIVELY HASHING** — both worker PIDs are
in state `R` with real CPU time (≈48–49% each); two hashing processes on a
2-CPU box is the expected steady-state picture.

## 2. Cumulative Attempts

| Source | Value |
|---|---|
| Checkpoint `totalAttempts` (durable) | **24,739,072** |
| Checkpoint sum check | worker0 12,359,296 + worker1 12,379,776 = **24,739,072** ✓ |
| Latest `[progress]` line (in-flight, ahead of last persisted write) | attempts=25,109,568, checkpointCount=256 |

Integrity checks beyond the sum:
- Worker 0 `nextNonce 0x1552d00` = 22,359,296 = 12,359,296 attempts since lane origin 0 ✓
- Worker 1 `nextNonce 0x17ba2a0` = 24,879,776 = lane origin 2,500,000 + 5,000,000·k bookkeeping + 2,379,776 attempts into chunk 4 ✓
- Both workers mid-`chunkIndex 4`, `exhausted: false` — lanes still disjoint and contiguous by construction.
- `candidate: null` in the checkpoint.

**Valid real throughput** (correcting for the progress line's known cumulative-
attempts ÷ per-session-elapsed metric): invocation#2 hashed its 10M budget in
492 s ⇒ **≈ 20,300 H/s live**, consistent with the 20,924 H/s benchmark (the
`rate=49xxx/s` values printed in progress lines are inflated by using
cumulative attempts; see prior timing audits).

## 3. Checkpoint Freshness and Validity

- **Last successful update: 2026-10-31 09:56:56.585 UTC** (seconds before this
  inspection); `checkpointCount: 251` at that write, 256 on the newest line.
- JSON is valid, schema `cashbi-genesis-mining-checkpoint` v1, genesis identity
  matches production (`preimageDigest 0xcec2e282…983209`, chainId 901291,
  difficulty 1, powLimit, block time 600 s, retarget interval 1536,
  `paramVersion "0.0.1-dev"`); frozen plan (`startNonce 0x0`, workers 2,
  laneChunkSize 2,500,000) intact.

## 4. Result Artifact

**Not present** (`/workspaces/codespaces-blank/.work/genesis-search/
cp.json.result.json` does not exist) ⇒ no candidate has been found; nothing to
verify yet. Independent verification via the production verifier will follow
the documented protocol the moment it appears.

## 5. Errors / Unexpected Restarts

- `grep -iE "error|fail|abort|SIGTERM|SIGKILL|killed"` over
  `search-output.log` and `invocations.log`: **zero matches**.
- Only observed loop events: `invocation#1 exit=0`, `invocation#2 exit=0` — both
  clean budget exhaustions with immediate relaunch.
- Worker PIDs observed were from the current invocation only; earlier worker
  process exits were normal per-invocation shutdown (budget exhausted), not
  crashes.

## 6. Survival Risks (distinguished, no persistence guarantees assumed)

| Event | Does the search survive? | What happens |
|---|---|---|
| **Browser/SSH disconnect** (Codespace container keeps running) | **YES** — the loop is detached from any TTY session (`ppid 2150`, not 1); it keeps hashing and updating the checkpoint. | Nothing to do; reconnect and re-check. |
| **Codespace suspension / machine stop** (idle timeout, manual stop button) | **NO** — all processes receive SIGKILL. Progress persists to the last atomic checkpoint; at most the last <100,000 attempts (~5 s of work) are not recorded. | After restart, manually execute the safe resume command in §7; progress is never reset silently. |
| **Container restart** (includes suspension restart, `devcontainer` reload) | **NO** — same as suspension: background processes are gone; workspace files (`.work/genesis-search/`) persist across restarts. | Resume manually with the same command. |
| **Full machine deletion / rebuild from scratch** | Workspace contents may be lost. | The Reports + pushed history document how to restart the search from the appropriate nonce. |

## 7. Exact Safe Resume Command (NOT executed, per task rules)

```bash
cd /workspaces/codespaces-blank
npm run mine-genesis -- \
  --start 0x0 \
  --max-attempts 10000000 \
  --workers 2 \
  --checkpoint /workspaces/codespaces-blank/.work/genesis-search/cp.json \
  --result /workspaces/codespaces-blank/.work/genesis-search/cp.json.result.json \
  --mine \
  --chunk-size 1024 \
  --checkpoint-every 100000
```

Run only if the search is actually stopped. The tool validates the checkpoint
(schema, origin identity, frozen plan, worker lanes) and resumes exactly from
each worker's saved `nextNonce` — no nonce is ever hashed twice.

---

## Summary / Verdict: **HEALTHY**

| # | Question | Answer |
|---|---|---|
| 1 | Supervisor alive? | YES (PID 5947, up since 09:39:25) |
| 2 | Mining or waiting? | HASHING (invocation #3 in flight since 09:57:14) |
| 3 | Workers alive/hashing? | YES, both (`state R`, expected CPU share) |
| 4 | Cumulative attempts | 24,739,072 durable (25,109,568 in-flight) |
| 5 | Checkpoint last update | 2026-10-31 09:56:56 UTC |
| 6 | Checkpoint JSON valid/consistent? | YES (schema/identity/plan/sums all cross-checked) |
| 7 | Result artifact | Absent — no candidate yet |
| 8 | Errors/restarts | NONE (two clean exit=0 invocations, immediate relaunch) |
| 9 | Persistence guarantees | Disconnect: survives. Suspension/stop/container restart: does NOT — manual resume required. |
| 10 | Safe resume command | Provided, not executed |

**Real live throughput ≈ 20,300 H/s** — on track with the calibrated estimate of
~4,295,032,833 expected hashes per valid nonce (~56 h mean at this rate);
geometric variance means both fast and slow outcomes are normal.
**No valid nonce has been found yet; nothing claimed beyond that.**
No source, consensus, checkpoint, or result modification; no commits or pushes;
the search has continued uninterrupted throughout.
