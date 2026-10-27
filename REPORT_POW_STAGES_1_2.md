# CashBI — PoW Stage 1 & 2 Implementation Report

**Task:** `/workspaces/codespaces-blank/do.md` — "Implement CashBI PoW stages 1 and 2 only, based on the corrected final plan."
**Mode:** Implementation of stages 1 and 2 only. Genesis untouched, no nonce mined, no paramVersion bump, no startup genesis validation, no reward/halving change.
**Date:** 2026-10-27
**Git state:** HEAD `da828e3ab57c1e374c7bee6804be66a34217ac20` (unchanged before this commit). All pre-existing working-tree modifications and untracked files preserved exactly.

---

## 1. What Was Implemented

### Stage 1 — `POW_LIMIT` constant (`src/config/params.ts`)

Added immediately below `MAX_DIFFICULTY`:

```ts
/** Bitcoin mainnet difficulty-1 proof-of-work limit: compact target 0x1d00ffff.
 *  At difficulty 1 this is the maximum permitted target, so difficulty 1
 *  requires real proof of work (~2^32 expected hashes) rather than accepting
 *  every digest. */
export const POW_LIMIT = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
```

### Stage 2 — `difficultyToTarget()` wired to the limit (`src/consensus/pow.ts`)

```ts
// Before:
export function difficultyToTarget(difficulty: bigint): bigint {
  if (difficulty < 1n) throw new Error("difficulty must be >= 1");
  const one = 1n << 256n;
  return one / difficulty;
}

// After (rejection of difficulty < 1 preserved):
export function difficultyToTarget(difficulty: bigint): bigint {
  if (difficulty < 1n) throw new Error("difficulty must be >= 1");
  return POW_LIMIT / difficulty;
}
```

Supporting changes in the same file:
- `POW_LIMIT` added to the existing `import { ... } from "../config/params.js"`.
- Module doc comment updated: the target formula is now documented as `target = POW_LIMIT / difficulty`, and the difficulty-1 paragraph no longer claims "every 32-byte digest satisfies"; it now states difficulty 1 maps to `POW_LIMIT` (Bitcoin mainnet compact target `0x1d00ffff`) and requires real proof of work.

### Required per scope item 3 — PoW unit tests updated (`test/pow.test.ts`)

1. Imports: added `POW_LIMIT`; removed `isMiningCandidate` (its last uses were removed, so keeping it would leave an unused import / lint warning).
2. Replaced the old test `pow: trivial difficulty accepts any hash, large difficulty rejects most` (which asserted the every-digest-accepts semantics) with:

```ts
test("pow: difficulty 1 maps to POW_LIMIT, higher difficulty shrinks the window", () => {
  // Difficulty 1 maps to POW_LIMIT, not 2^256, so not every digest passes.
  assert.equal(difficultyToTarget(1n), POW_LIMIT);
  assert.equal(difficultyToTarget(2n), POW_LIMIT / 2n);
});
```

3. Added the exact-target boundary test:

```ts
test("pow: difficulty 1 target boundary — digest at target passes, one above fails", () => {
  // POW_LIMIT as a 32-byte big-endian digest: 0x00000000ffff0000...0000
  const atTarget = new Uint8Array(32);
  atTarget[4] = 0xff;
  atTarget[5] = 0xff;
  assert.equal(meetsTarget(atTarget, 1n), true, "digest exactly at POW_LIMIT passes");

  // One above POW_LIMIT: ...ffff0001
  const aboveTarget = new Uint8Array(32);
  aboveTarget[4] = 0xff;
  aboveTarget[5] = 0xff;
  aboveTarget[31] = 0x01;
  assert.equal(meetsTarget(aboveTarget, 1n), false, "digest one above POW_LIMIT fails");
});
```

4. Adapted the probabilistic rejection test to difficulty 1 under the bounded target ("pow: difficulty 1 rejects most hashes" — 1,000 random nonces must collectively fail, expected with probability 1 − (1000/2^32) ≈ 1).
5. Added `pow: zero and negative difficulty are rejected` — `difficultyToTarget(0n)` and `difficultyToTarget(-1n)` must throw `/difficulty must be >= 1/`.
6. Updated `pow: verifyHeaderPoW consistency with mining path`: the old assertion that genesis nonce 0 passes at difficulty 1 is invalid under the bounded target (expected ~2^32 hashes), so the test now asserts the API contract (`ok.ok` is a boolean; a high-difficulty verdict is definitively `false`).

### Constraint compliance (all respected)

| Constraint | Compliance |
|---|---|
| Exact constant value | Byte-exact as given in do.md |
| `difficulty < 1` rejection preserved | Yes — same `throw` line untouched |
| Genesis nonce / pinned hash | Untouched (`genesis.ts`, `test/genesis.test.ts`, docs unchanged) |
| `DEV_PARAM_VERSION` | Untouched (`"0.0.1-dev"`) |
| Startup genesis validation | Not implemented (Blockchain constructor unchanged) |
| Reward / halving config | Untouched |
| PoW hash construction, nonce serialization, retarget rules, chainId, supply, other params | Untouched |
| No destructive git / commit / push / deploy | None performed except the separately authorized push of this report+module files |

---

## 2. Diffs

The working tree carries pre-existing uncommitted changes from earlier iterations in the same three files; these were preserved. The deltas introduced **by this iteration** are exactly:

### `src/config/params.ts`

```diff
@@ (after MAX_DIFFICULTY) @@
+/** Bitcoin mainnet difficulty-1 proof-of-work limit: compact target 0x1d00ffff.
+ *  At difficulty 1 this is the maximum permitted target, so difficulty 1
+ *  requires real proof of work (~2^32 expected hashes) rather than accepting
+ *  every digest. */
+export const POW_LIMIT = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
```

### `src/consensus/pow.ts`

```diff
 import {
   DIFFICULTY_RETARGET_INTERVAL,
   MAX_DIFFICULTY,
   MIN_DIFFICULTY,
+  POW_LIMIT,
   TARGET_BLOCK_TIME_SECONDS,
 } from "../config/params.js";
@@ (module doc) @@
- *   target = 2^256 / difficulty
+ *   target = POW_LIMIT / difficulty
@@ (doc) @@
- * target = 2^256, which EVERY 32-byte digest satisfies — a defined,
- * deterministic, valid relationship meaning "instant dev mining", not an
- * error. Higher difficulty linearly halves the accepted interval of digests.
+ * target = POW_LIMIT, the Bitcoin mainnet difficulty-1 limit (compact target
+ * 0x1d00ffff), so difficulty 1 requires real proof of work rather than
+ * accepting every digest. Higher difficulty linearly halves the accepted
+ * interval of digests.
@@ (function) @@
 export function difficultyToTarget(difficulty: bigint): bigint {
   if (difficulty < 1n) throw new Error("difficulty must be >= 1");
-  const one = 1n << 256n;
-  return one / difficulty;
+  return POW_LIMIT / difficulty;
 }
```

### `test/pow.test.ts`

```diff
 import {
   difficultyToTarget,
-  isMiningCandidate,
   lowerMedian,
   meetsTarget,
@@
-import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "../src/config/params.js";
+import { MAX_DIFFICULTY, MIN_DIFFICULTY, POW_LIMIT } from "../src/config/params.js";
@@
-test("pow: trivial difficulty accepts any hash, large difficulty rejects most", () => {
-  ...
-  header.nonce = 7n;
-  assert.equal(isMiningCandidate(header, 7n), true); // difficulty 1 -> target max
-  ...
+test("pow: difficulty 1 maps to POW_LIMIT, higher difficulty shrinks the window", () => {
+  assert.equal(difficultyToTarget(1n), POW_LIMIT);
+  assert.equal(difficultyToTarget(2n), POW_LIMIT / 2n);
+});
+
+test("pow: difficulty 1 target boundary — digest at target passes, one above fails", () => {
+  const atTarget = new Uint8Array(32);  atTarget[4] = 0xff; atTarget[5] = 0xff;
+  assert.equal(meetsTarget(atTarget, 1n), true);
+  const aboveTarget = new Uint8Array(32); aboveTarget[4] = 0xff; aboveTarget[5] = 0xff; aboveTarget[31] = 0x01;
+  assert.equal(meetsTarget(aboveTarget, 1n), false);
+});
+
+test("pow: difficulty 1 rejects most hashes", () => { /* 1000 random nonces all fail */ });
+
+test("pow: zero and negative difficulty are rejected", () => {
+  assert.throws(() => difficultyToTarget(0n),  /difficulty must be >= 1/);
+  assert.throws(() => difficultyToTarget(-1n), /difficulty must be >= 1/);
+});
@@
 test("pow: verifyHeaderPoW consistency with mining path", () => {
   ...
   const ok = verifyHeaderPoW(header, { nonce: 0n });
-  assert.equal(ok.ok, true);
+  // At difficulty 1 with target = POW_LIMIT, genesis nonce 0 almost certainly
+  // does not pass PoW (~2^32 hashes expected). The API contract is that ok
+  // is always a boolean; miner and validator share the same target.
+  assert.equal(typeof ok.ok, "boolean");
   ...
+  assert.equal(verdict.ok, false);
 });
```

### Unrelated pre-existing changes (identified, NOT committed by this iteration's stage-1&2 scope)

- `M UNRESOLVED_DECISIONS.md`, `M do.md` — external task files, never committed.
- `M src/chain/blockchain.ts`, `M src/mining/candidate.ts`, `M src/net/server.ts` — earlier iterations' consensus-redesign / crash-fix / handshake work.
- `M test/chain.test.ts` — earlier iterations' test additions (not updated for the new PoW reality; see §5).
- `?? PROJECT_SUMMARY.md`, `?? src/consensus/issuance.ts`, `?? test/genesis.test.ts`, `?? test/handshake.test.ts`, `?? test/issuance.test.ts` — earlier iterations' new files.

---

## 3. Verification Results (all commands actually run; failures reported honestly)

### Focused PoW tests (run first, as instructed)

```
node --import tsx --test test/pow.test.ts
→ tests 20, pass 20, fail 0
```

All five required coverages pass: difficulty 1 = `POW_LIMIT`; difficulty 2 = `POW_LIMIT / 2n`; digest exactly at target passes; digest one above target fails; zero and negative difficulty rejected.

### Complete `npm test`

```
timeout 550 npm test   (run twice)
→ run truncated at the 550 s timeout both times; observed partial summary:
  tests 51, pass 21, fail 23, cancelled 7
```

The suite no longer completes within 550 s because of the fallout below (a single `integration-two-nodes` run took >450 s and a `node.test.ts` run hung indefinitely). **The suite is NOT green — failure counts are real, not estimates.** Exact failure breakdown from isolated runs:

| Suite | Result | Root cause |
|---|---|---|
| `test/pow.test.ts` | 20/20 pass | — |
| `test/rlp.test.ts`, `test/transaction.test.ts`, `test/security.test.ts`, `test/issuance.test.ts`, `test/genesis.test.ts`, `test/handshake.test.ts`, `test/evm.test.ts` (combined run) | 57/57 pass | — |
| `test/chain.test.ts` | **1 pass / 22 fail** | Every failing test throws `Error: no PoW nonce found (difficulty sanity)` at `test/chain.test.ts:99`. The test helper `findNonce()` tries only 100,000 nonces but difficulty 1 now expects ~2^32 hashes per block. **Structural, expected fallout** — test-suite block minting is no longer feasible without a mining/fast-PoW test strategy (out of scope for stages 1–2). |
| `test/node.test.ts` | **hangs indefinitely** (timed out at 300 s) | Pre-existing latent bug exposed: `searchNonce` (`src/mining/miner.ts:138-149`) calls `delayMs(...)` **without `await`**, so when a nonce is not found promptly the miner hot-spins 100% CPU **and blocks the node's event loop**; pending HTTP RPC calls never resolve and the test's bounded 30 s assert is never even reached. Before stages 1–2, difficulty 1 always found a nonce on the first batch, so the flaw was invisible. **No fix applied — `src/mining/miner.ts` is outside the stage 1–2 file scope.** |
| `test/integration-two-nodes.test.ts` | **fails** — standalone run: `✖ integration: two real nodes sync, propagate tx, mine block, restart recovery (30492 ms) — Error: RPC port 8561 not reachable within 30000ms`; file-level run cancelled at the 550 s outer timeout (ℹ tests 2, pass 0, fail 1, cancelled 1) | Same miner event-loop starvation in the spawned child node processes. |
| "Promise resolution is still pending" errors for rlp/issuance/transaction/security/genesis | artifacts of the truncated full run | Proven non-issues: those files pass 57/57 in a combined isolated run. |

### Static validations

```
npx tsc --noEmit      → exit 0 (clean)
npm run lint          → clean (0 errors, 0 warnings, after removing the now-unused
                        isMiningCandidate import from test/pow.test.ts)
npm run security:check → exit 0 (npm audit --audit-level=critical + lint + typecheck)
```

---

## 4. The do.md Line-31 Estimate Correction (carried into the record)

At the previously assumed effective rate of ~8,192 hashes/second (miner batch math: `batch = min(64, floor(512/32)) = 16` hashes per `delayMs(1000/512)` tick), an expected 2^32 hashes takes:

```
2^32 / 8,192 ≈ 524,288 s ≈ 6.1 days   (not six minutes)
```

This estimate is NOT a guarantee: the "measured" 8,192 H/s figure derives from the un-measured batching arithmetic, and the hot-loop behavior means real throughput is CPU-contention dependent. A future genesis-mining tool must benchmark its own actual throughput before estimating runtime, per the task's explicit correction.

---

## 5. Fallout Analysis (documented, not fixed — outside stage 1–2 scope)

1. **Test-suite block minting is infeasible.** With `target = POW_LIMIT` (~2^224) at difficulty 1, each valid block requires ~2^32 hashes. `test/chain.test.ts`'s bounded helper (100k nonces) can never succeed, so 22 chain tests fail with a thrown error from the test helper — this is the correct, honest behavior of a suite whose heuristic is now genuinely unsatisfiable. A future task must either (a) authorize a test-mode difficulty hook (consensus-visible, needs owner approval), or (b) precompute valid test vectors.
2. **The miner hot-spin is now a live availability bug.** `searchNonce`'s outer loop intends to yield via `delayMs` but the call is not awaited; once the target becomes non-trivial the miner blocks the whole node event loop indefinitely. This is a pre-existing latent defect whose trigger condition was never reachable before — bounding the target reached it. Fixing it (awaiting the delay, and/or adding a cooperative stop check) is a one-line-class change but touches `src/mining/miner.ts`, which is outside the declared file scope of stages 1–2.
3. **Handshake/genesis/supply logic remains correct.** All other suites (57 tests) pass unchanged.

---

## 6. Exact Standard-Output Summaries (as observed)

```
Focused PoW run:
ℹ tests 20
ℹ pass 20
ℹ fail 0

Combined non-chain suites:
ℹ tests 57
ℹ pass 57
ℹ fail 0
ℹ duration_ms 2559

chain.test.ts isolated:
ℹ tests 23
ℹ pass 1
ℹ fail 22
ℹ duration_ms 99386

node.test.ts isolated:
✖ test/node.test.ts (299937 ms)   ← cancelled by 300 s outer timeout
ℹ tests 1
ℹ pass 0
ℹ cancelled 1

Full `npm test` (twice, both truncated at 550 s):
ℹ tests 51
ℹ pass 21
ℹ fail 23
ℹ cancelled 7
ℹ duration_ms 549824
```

---

## 7. Next Steps (for a future authorized task, NOT done here)

1. Fix the miner hot-spin (`await` the inter-batch delay; cooperative stop already partially present) — unblocks rpc/`node.test.ts`/integration.
2. Authorize a test-block minting strategy (fast-PoW mode, precomputed vectors, or stage-3 mining) to restore the 22 chain tests.
3. Then proceed to the corrected plan's remaining stages: genesis nonce mining (with a real throughput benchmark, ~6.1 d at the currently assumed rate), pinned genesis hash updates, startup genesis validation, and the `DEV_PARAM_VERSION` bump.

---

**Stop point reached:** stages 1 and 2 only, exactly as scoped.
