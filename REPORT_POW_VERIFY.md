# CashBI — Verify PoW Test Isolation and Add Real Block-Validation Coverage Report

**Task:** `/workspaces/codespaces-blank/do.md` — "CashBI — Verify PoW Test Isolation and Add Real Block-Validation Coverage"
**Date:** 2026-10-28
**Git state at start:** HEAD `a3cbe471e51a9f967a3840c93cb78aac74abc8ae` (pushed to `origin/main`)
**Git state at end:** HEAD `a3cbe471e51a9f967a3840c93cb78aac74abc8ae` (unchanged — nothing committed or pushed)
**Working tree at start:** `M do.md`, `D REPORT_POW_HARDEN.md` (stale report removed by task environment)
**Working tree at end:** `M do.md` (unchanged)

---

## 1. Workspace Preservation

Before any editing, the current state was inspected:

- `git status`: Only `do.md` modified and `REPORT_POW_HARDEN.md` deleted (by task environment, expected behavior)
- HEAD: `a3cbe471e51a9f967a3840c93cb78aac74abc8ae`
- No files were reset, cleaned, stashed, discarded, or overwritten
- Nothing was committed or pushed
- All existing modifications and untracked files preserved

---

## 2. Audit of Test-Only PoW Bypass (§2 of do.md)

### 2.1 Production `Blockchain` Construction

All production code paths construct `Blockchain` with only the `config` argument — there is **no constructor option** to inject an alternate PoW validator:

| Caller | File | Line | Construction |
|---|---|---|---|
| `FullNode.loadChain()` | `src/node/node.ts` | 138 | `new Blockchain(genesis)` |
| `Blockchain.loadFromLedger()` | `src/chain/blockchain.ts` | 122 | `new Blockchain(config)` |
| `scripts/smoke.ts` | `scripts/smoke.ts` | 32 | `new Blockchain(genesis)` |

### 2.2 `checkPoW()` Method

`checkPoW()` is a `protected` method on `Blockchain` that calls `verifyHeaderPoW()` directly:

```ts
protected checkPoW(header: BlockHeader, nonce: bigint): ImportedReceipt | null {
  const pow = verifyHeaderPoW(header, { nonce });
  if (!pow.ok) return { ...this.tipInfo(), reorganized: false, reason: pow.reason ?? "PoW validation failed" };
  return null;
}
```

`tryImport()` calls `this.checkPoW(block.header, block.header.nonce)` at line 239. There is no way for production code to substitute a different validator.

### 2.3 Test-Only Subclass

`BlockchainForTesting` is defined **only** in `test/chain.test.ts` (lines 27-31):

```ts
class BlockchainForTesting extends Blockchain {
  protected checkPoW(_header: BlockHeader, _nonce: bigint): ImportedReceipt | null {
    return null; // test-only: skip PoW hash check; all other rules still apply
  }
}
```

It is used exclusively by:
- `fundedChain()` (line 40): `new BlockchainForTesting(genesis)`
- `bigChain` supply-cap test (line 316): `new BlockchainForTesting(bigGenesis)`

### 2.4 Boundary Assessment

**TypeScript `protected` is not an absolute runtime boundary**, but the actual production import and construction graph confirms the boundary is sound:

| Potential bypass vector | Status |
|---|---|
| Public constructor option for validator injection | **None** — constructor takes only `config` |
| Environment variable affecting PoW validation | **None** |
| Global mutable state affecting PoW validation | **None** |
| Alternate production API that disables PoW | **None** |
| `BlockchainForTesting` imported by production code | **None** — defined only in test code, no production file imports test files |
| Production code creating a subclass of `Blockchain` | **None** — all production code constructs plain `Blockchain` |

**Conclusion:** The production/test boundary is sound. `BlockchainForTesting` cannot accidentally become a production dependency through imports or refactoring because it is defined exclusively in test code, and all production construction paths use `new Blockchain(genesis)` with no bypass option.

---

## 3. Valid-PoW Acceptance Test (§3 of do.md) — BLOCKER

### 3.1 Requirement

Add a deterministic test that submits a genuinely valid block through the normal production `Blockchain.acceptBlock()` path, using a precomputed valid nonce/header fixture.

### 3.2 Why It Cannot Be Completed

At difficulty 1, `target = POW_LIMIT / 1 = POW_LIMIT` where:

```
POW_LIMIT = 0x00000000ffff0000000000000000000000000000000000000000000000000000
          ≈ 2^224
```

A valid nonce must satisfy `powHash(header, nonce) <= POW_LIMIT`. The probability of any single hash passing is:

```
P = 2^224 / 2^256 = 2^-32 ≈ 2.3 × 10^-10
```

Expected hashes to find a valid nonce: **2^32 ≈ 4.3 billion**.

### 3.3 Mining Attempt

Two background miners were started (one per CPU), each searching a 1-billion-nonce range:

| Worker | Nonce Range | Chance of Success |
|---|---|---|
| 0 | [0, 10^9) | ~23% |
| 1 | [10^9, 2×10^9) | ~23% |

Combined hash rate: ~23.7K H/s (11.8K H/s per thread). Expected time to find a nonce: ~4.3e9 / 2.37e4 ≈ 181,000 seconds ≈ **50 hours**.

No nonce was found within the task window. Miners continue running in the background.

### 3.4 Decision

Per do.md §3: *"If a trustworthy valid fixture cannot be produced within this task, report the blocker clearly. Do not fabricate a nonce or claim valid-PoW coverage without verifying it."*

**This blocker is reported clearly.** No valid-PoW acceptance test was added, and no valid-PoW acceptance coverage is claimed.

---

## 4. Real P2P Block-Propagation Coverage (§4 of do.md) — BLOCKER

### 4.1 Requirement

Extend the two-node integration test to exercise actual block propagation through the production networking and validation paths, propagating a block with genuinely valid PoW from one node to another.

### 4.2 Why It Cannot Be Completed

The P2P block reception path (`FullNode.onExternalBlock()`, `src/node/node.ts:286-307`) calls `this.chain.acceptBlock(block)`, which calls `checkPoW()` → `verifyHeaderPoW()`. A block with an invalid nonce (e.g., nonce 0) would be rejected by the receiving node.

To test end-to-end P2P propagation, we need a block with a valid PoW nonce (~2^32 expected hashes to find one). This is the same blocker as §3.

### 4.3 Decision

Per do.md §4: *"If the existing networking setup makes a trustworthy test infeasible without changing consensus, explain precisely why and leave the gap explicitly documented."*

**This gap is documented explicitly.** No P2P propagation test with real PoW was added. The existing integration test continues to verify P2P handshake, peer connection, transaction submission, restart recovery, and mismatched-genesis rejection — but not block propagation with valid PoW.

---

## 5. Consensus and Genesis Constraints (§5 of do.md)

All constraints verified as respected:

| Constraint | Status |
|---|---|
| `POW_LIMIT` unchanged | ✅ Not modified |
| PoW hash construction unchanged | ✅ Not modified |
| Difficulty/retarget rules unchanged | ✅ Not modified |
| Chain ID `901291` unchanged | ✅ Not modified |
| Supply cap `16,000,000 BIC` unchanged | ✅ Not modified |
| Block rewards/halving unchanged | ✅ Not modified |
| Genesis fields/nonce/hash unchanged | ✅ Not modified |
| `paramVersion`/handshake rules unchanged | ✅ Not modified |
| Genesis not mined or re-mined | ✅ No genesis mining performed |
| No genesis startup validation added | ✅ Not added |
| No chain data migrated or modified | ✅ No chain data changes |

---

## 6. Verification Results (§6 of do.md)

### 6.1 Focused PoW Tests

```
node --import tsx --test test/pow.test.ts
→ tests 21, pass 21, fail 0, duration ≈ 2.0 s
```

### 6.2 Chain Tests

```
node --import tsx --test test/chain.test.ts
→ tests 23, pass 23, fail 0, duration ≈ 2.3 s
```

### 6.3 Two-Node Integration Test

```
node --import tsx --test test/integration-two-nodes.test.ts
→ tests 1, pass 1, fail 0, duration ≈ 10.8 s
```

### 6.4 Complete `npm test` Suite

```
npm test
→ tests 89, pass 89, fail 0, duration ≈ 19.1 s
```

All 89 tests pass, including:
- 21 PoW tests (including `acceptBlock rejects block with invalid PoW`)
- 23 chain tests (all using `BlockchainForTesting` for non-PoW validation rules)
- 1 node test
- 1 integration test
- 15 RLP tests
- 10 EVM tests
- 5 key tests
- 4 transaction tests
- 4 mempool tests
- 4 security tests
- 1 util test
- 1 genesis test (noted as untracked/new file)

### 6.5 Static Checks

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Exit 0 (clean) |
| `npm run lint` | Exit 0 (0 errors, 0 warnings) |
| `npm run security:check` | Exit 0 (0 vulnerabilities, lint clean, typecheck clean) |

---

## 7. Files Changed During This Task

**No source files were changed.** The task was primarily an audit plus two blocked items (valid-PoW acceptance test and P2P propagation test) that could not be completed due to the computational infeasibility of precomputing a valid PoW nonce (~2^32 hashes, ~50 hours at measured rate).

The only working-tree change is `M do.md` (the task file itself, which is expected to be rewritten externally each iteration).

### Files Reviewed but Not Changed

| File | Purpose |
|---|---|
| `src/chain/blockchain.ts` | Production `Blockchain` class — verified no bypass injection point |
| `test/chain.test.ts` | Test file using `BlockchainForTesting` — verified test-only |
| `test/pow.test.ts` | PoW unit tests — verified all 21 pass |
| `src/node/node.ts` | Full node — verified production `Blockchain` construction with no bypass |
| `src/net/server.ts` | P2P server — verified handshake and message handling |
| `test/integration-two-nodes.test.ts` | Integration test — verified all 1 pass |

---

## 8. Remaining Gaps and Blockers

### 8.1 Valid-PoW Acceptance Test (BLOCKER)

**Root cause:** Finding a valid PoW nonce at difficulty 1 requires ~2^32 hashes (~50 hours at 23.7K H/s combined). This is computationally infeasible within a single task iteration.

**Required to close:** A precomputed valid nonce/header fixture. Background miners are running (2 workers, searching nonces [0, 2×10^9)). If a nonce is found, it can be added as a deterministic test vector in `test/pow.test.ts`.

### 8.2 P2P Block-Propagation Test (BLOCKER)

**Root cause:** Same as above — requires a block with valid PoW to propagate between two nodes through the production `onExternalBlock()` → `acceptBlock()` → `verifyHeaderPoW()` path.

**Required to close:** A precomputed valid nonce/header fixture, then extending `test/integration-two-nodes.test.ts` to:
1. Mine/generate a block with valid PoW on node A
2. Propagate it via `NEW_BLOCK` message to node B
3. Assert node B accepts it and advances to the expected tip

---

## 9. Confirmation

- ✅ Consensus parameters (`POW_LIMIT`, difficulty, retarget, chain ID, supply cap, rewards) left unchanged
- ✅ Genesis fields, nonce, hash, initialization left unchanged
- ✅ `paramVersion` and handshake rules left unchanged
- ✅ Nothing was committed or pushed
- ✅ All existing modifications and untracked files preserved
- ✅ All 89 tests pass
- ✅ All static checks pass (`tsc`, `lint`, `security:check`)

---

## 10. Background Processes

Two PoW miners are running in the background (PIDs started via `nohup`):

- Worker 0: searching nonces [0, 10^9)
- Worker 1: searching nonces [10^9, 2×10^9)
- Output: `/tmp/opencode/mine_0.log`, `/tmp/opencode/mine_1.log`
- If a nonce is found, it will be written to `/tmp/opencode/found_nonce_<workerId>.json`
