# CashBI — PoW Correctness Audit and Deterministic Test Report

**Task:** `/workspaces/codespaces-blank/do.md` — "CashBI — Audit PoW Correctness and Design Fast Deterministic Tests"
**Date:** 2026-10-28
**Git state at start:** HEAD `f42f37ef518d66d85d39365e775a0c7c3f64a5da` (pushed to `origin/main`)
**Git state at end:** HEAD `f42f37ef518d66d85d39365e775a0c7c3f64a5da` (unchanged — nothing committed or pushed)
**Working tree at start:** `D REPORT_POW_HARDEN.md`, `D REPORT_POW_VERIFY.md`, `M do.md`, `M test/pow.test.ts`
**Working tree at end:** `D REPORT_POW_HARDEN.md`, `D REPORT_POW_VERIFY.md`, `M do.md`, `M test/pow.test.ts`, `?? REPORT_POW_AUDIT.md`

---

## 1. Inspection of Actual Implementation (§1 of do.md)

### Files inspected

| File | Purpose |
|---|---|
| `src/consensus/pow.ts` | PoW hash construction, difficulty→target, retarget rules, verifyHeaderPoW |
| `src/config/params.ts` | POW_LIMIT, MIN_DIFFICULTY, MAX_DIFFICULTY, TARGET_BLOCK_TIME_SECONDS |
| `src/chain/block.ts` | BlockHeader/Block types, RLP header serialization, blockHash, encodeBlock/decodeBlock |
| `src/chain/blockchain.ts` | tryImport/acceptBlock validation, checkPoW() protected method |
| `src/mining/candidate.ts` | buildBlockForMining/buildBlockOn template construction |
| `test/pow.test.ts` | Existing PoW unit tests |

### Key consensus facts verified from source

| Parameter | Value |
|---|---|
| `POW_LIMIT` | `0x00000000ffff0000...0000` (≈ 2^224, Bitcoin compact `0x1d00ffff`) |
| `difficultyToTarget(d)` | `POW_LIMIT / d` |
| `powHash` | `SHA-256(SHA-256(keccak256(RLP(headerWithoutNonce)) || 8-byte BE nonce))` |
| `meetsTarget(digest, difficulty)` | `hexBEToBig(digest) <= difficultyToTarget(difficulty)` |
| Genesis difficulty | 1 |
| Retarget interval | 1536 blocks |
| Target block interval | 600 s |
| Chain ID | 901291 |

`Blockchain` constructor takes only `config` — no validator injection option in production. `checkPoW()` is `protected`, calls `verifyHeaderPoW()` directly.

---

## 2. Deterministic PoW Primitive Tests (§2 of do.md)

Six new tests were added to `test/pow.test.ts` (all deterministic, no mining, no network):

### 2.1 Tests added

| Test | What it verifies | Independence |
|---|---|---|
| `pow: header serialization — RLP byte ordering matches field-by-field encoding` | `encodeHeaderView()` matches independent per-field RLP encoding | Partial — uses same `RLP.fromUint`/`fromHex` primitives as implementation under test, but independently verifies field ordering and selection. Also pins exact `RLP.fromUint` outputs for 0, 1, 255, 256, 65535, 65536. |
| `pow: nonce encoding — 8-byte big-endian boundaries` | `bigToHexBE()` nonce serialization at boundaries | **High** — all values hardcoded as byte arrays; no dependency on implementation under test |
| `pow: digest-to-integer interpretation via hexBEToBig` | `hexBEToBig()` big-endian digest interpretation | **High** — all values hardcoded; no dependency on implementation under test |
| `pow: difficulty 2 target boundary — digest at target passes, one above fails` | `meetsTarget()` at difficulty 2 | Medium — uses `POW_LIMIT / 2n` for expected target (same formula as `difficultyToTarget`), but hardcoded byte array independently computed via bit-shift math |
| `pow: block encode/decode roundtrip preserves all header fields` | `encodeBlock()`/`decodeBlock()` roundtrip | Low — uses same RLP implementation as code under test; internal consistency check only |
| `pow: powHash matches independent Node.js crypto computation` | `powHash()` construction | Partial — uses Node's `crypto.createHash` for outer double-SHA-256 (independent), but `hashHeaderWithoutNonce` (keccak+RLP) shares implementation |

### 2.2 Design choices

- **Independently calculated fixtures:** The header serialization test independently encodes each RLP field. The powHash test uses Node's built-in `crypto.createHash` (not `@noble/hashes`) for the outer double-SHA-256. The nonce/digest tests use literal byte arrays.
- **No synthetic digest confused with real block acceptance:** The `meetsTarget` boundary test at difficulty 2 tests the target-comparison primitive directly. No claim is made that a real block passes production `acceptBlock()` — that requires a valid PoW nonce (~2^32 expected hashes), explicitly not mined here (do.md §3).
- **No PoW bypass added:** All tests use production `verifyHeaderPoW`/`meetsTarget`/`difficultyToTarget` or test-only `BlockchainForTesting` (which overrides `checkPoW()` to return `null`). No bypass exists in production code.

### 2.3 Corrections made during audit

The initial version of the difficulty-2 boundary test had two errors that were caught during the audit:

1. **Wrong hardcoded bytes:** The initial bytes `[0x7f, 0xfe, 0x00, ...]` at positions 4-6 were incorrect. The correct bytes for `POW_LIMIT / 2n` are `[0x7f, 0xff, 0x80, ...]` (right-shifting `0xffff00...0000` by 1 bit produces `0x7f, 0xff, 0x80` at positions 4-6).
2. **Wrong expected target constant:** `BigInt("0x7fff80") * BigInt(2) ** BigInt(192)` was mathematically incorrect. The correct value is simply `POW_LIMIT / 2n`.

Both bugs would have caused test failures or false confidence. They were caught during the audit process.

---

## 3. Valid-Header Fixture Review (§3 of do.md)

### Finding: No valid PoW fixture exists

A search of the repository confirmed no precomputed valid PoW nonce/header fixture exists anywhere in the codebase. `test/pow.test.ts` lines 435-440 document this gap explicitly.

### Why one cannot be generated within this task

At difficulty 1, `target = POW_LIMIT ≈ 2^224`. A valid nonce must satisfy `powHash(header, nonce) <= POW_LIMIT`. Probability of any single hash passing = 2^-32, expected work = 2^32 ≈ 4.3 billion hashes. At a measured rate of ~23.7K H/s (2 threads), expected time ≈ 50 hours. This is computationally infeasible within a single task iteration.

### Constraints respected

- `POW_LIMIT` not changed ✅
- No mining jobs launched ✅
- No nonce fabricated ✅
- Target not weakened ✅

### Blocker documented

Valid-PoW acceptance via `acceptBlock()` and real P2P block propagation cannot be tested without a valid nonce. These gaps are **explicitly documented, not claimed** as test coverage (do.md §4).

---

## 4. Production Acceptance and P2P Claims (§4 of do.md)

### No PoW bypass added

| Location | Status |
|---|---|
| `src/chain/blockchain.ts` constructor | Takes only `config` — no validator injection option |
| `src/chain/blockchain.ts` `checkPoW()` | `protected`, calls `verifyHeaderPoW()` directly |
| `src/node/node.ts` `submitMinedBlock()` | Calls `chain.acceptBlock(block)` — real PoW |
| `src/node/node.ts` `onExternalBlock()` | Calls `chain.acceptBlock(block)` — real PoW |
| `src/chain/blockchain.ts` `loadFromLedger()` | Calls `chain.tryImport(decodeBlock(raw))` — real PoW |

### Tests using test-only bypass

`test/chain.test.ts` uses `BlockchainForTesting` (a `Blockchain` subclass overriding `checkPoW()` to return `null`) for non-PoW chain-validation rule tests. This subclass exists **only** in test code and is unreachable from production.

### Coverage gaps explicitly documented

| Gap | Why | What's needed |
|---|---|---|
| Valid block accepted by `acceptBlock()` | Requires valid PoW nonce (~2^32 hashes) | Precompute a nonce (~50 hours at ~23.7K H/s) |
| Real P2P block propagation | Same blocker | Same nonce + two-node integration test |

---

## 5. Constraints Verification (§5 of do.md)

| Constraint | Status |
|---|---|
| `POW_LIMIT` unchanged | ✅ Not modified |
| PoW hash construction unchanged | ✅ Not modified |
| Difficulty/retarget rules unchanged | ✅ Not modified |
| Chain ID `901291` unchanged | ✅ Not modified |
| Supply cap `16,000,000 BIC` unchanged | ✅ Not modified |
| Rewards unchanged | ✅ Not modified |
| Genesis unchanged | ✅ Not modified |
| `paramVersion`/handshake unchanged | ✅ Not modified |
| No genesis mining | ✅ No genesis mining performed |
| No genesis startup validation added | ✅ Not added |
| No chain data modified | ✅ No chain data changes |
| No commit/push/deploy | ✅ Nothing committed or pushed |
| No reset/clean/stash/discard | ✅ No destructive Git operations |
| All pre-existing changes preserved | ✅ `do.md`, deleted report files preserved |

---

## 6. Verification Results (§6 of do.md)

### Focused PoW tests

```
node --import tsx --test test/pow.test.ts
→ tests 27, pass 27, fail 0
```

### Complete `npm test` suite

```
npm test
→ tests 95, pass 95, fail 0, duration ≈ 17 s
```

(was 89 tests before this task; +6 new PoW tests)

### Static checks

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Exit 0 (clean) |
| `npm run lint` | Exit 0 (0 errors, 0 warnings) |
| `npm run security:check` | Exit 0 (0 vulnerabilities) |

---

## 7. Files Changed

| File | Change |
|---|---|
| `test/pow.test.ts` | +6 deterministic PoW tests, import cleanup, fixed byte constants |

### Files reviewed but not changed

| File | Purpose |
|---|---|
| `src/consensus/pow.ts` | PoW implementation — verified, no changes needed |
| `src/config/params.ts` | Consensus parameters — verified, no changes needed |
| `src/chain/block.ts` | Block serialization — verified, no changes needed |
| `src/chain/blockchain.ts` | Block validation — verified, no changes needed |
| `src/mining/candidate.ts` | Block template construction — verified, no changes needed |
| `src/node/node.ts` | Full node — verified production PoW path |
| `src/net/server.ts` | P2P server — verified handshake rules |

---

## 8. Remaining Coverage Gaps (Documented, Not Claimed)

| Gap | Why | What's needed |
|---|---|---|
| Valid-PoW acceptance via `acceptBlock()` | Requires valid PoW nonce (~2^32 hashes) | Precompute a nonce (~50 hours at ~23.7K H/s) |
| Real P2P block propagation | Same blocker | Same nonce + two-node integration test |

---

## 9. Git State

- HEAD: `f42f37ef518d66d85d39365e775a0c7c3f64a5da` (unchanged)
- Remote `origin/main`: `f42f37ef518d66d85d39365e775a0c7c3f64a5da` (unchanged)
- Nothing committed or pushed in this task
- Working tree: `M test/pow.test.ts` (this task's changes), `M do.md` (externally rewritten), `D REPORT_POW_HARDEN.md`, `D REPORT_POW_VERIFY.md` (pre-existing), `?? REPORT_POW_AUDIT.md` (this report)
