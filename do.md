# CashBI — Complete PoW Test Isolation and Valid-Header Verification

Repository: `/workspaces/codespaces-blank`

## Objective

Address the remaining security and test-coverage gaps identified in the 2026-10-28 PoW audit report.

### 1. Inspect the Actual API Boundary

Inspect `src/chain/blockchain.ts` and all callers of `acceptBlockForTesting()`, `tryImport()`, and `acceptBlock()`.

The current report says `acceptBlockForTesting()` is a method on the production `Blockchain` class. Do not assume that naming or documentation makes it inaccessible to production callers.

Determine whether ordinary production code can invoke this method.

### 2. Truly Isolate Test-Only PoW Bypass

Remove the test bypass from the public production API surface.

Use a safe design such as a test-only fixture, injected validation dependency restricted to test construction, or another architecture that ensures production node, RPC, mining, ledger-recovery, and P2P code cannot accidentally disable PoW.

Do not merely rename the bypass method.

Production block import must always perform actual PoW verification.

Keep tests for unrelated chain-validation rules fast without weakening production consensus.

If genuine isolation requires a larger architectural change, stop and report the smallest safe design rather than introducing an insecure workaround.

### 3. Add a Precomputed Valid-PoW Test Vector

The current tests prove that an invalid nonce is rejected, but do not prove that a valid block passes the normal production `acceptBlock()` path.

Add a deterministic, precomputed valid-PoW header fixture containing:
- Exact header fields and encoding.
- Exact nonce.
- Exact computed PoW digest.
- Exact difficulty and target.
- Expected verification result.

Verify the vector against the actual consensus implementation and independently reproduce the digest/target comparison where practical.

Do not perform billions of hashes during unit tests. Do not fabricate a valid nonce or treat the Genesis nonce as valid without verification.

Use the vector to test the ordinary production PoW verification path. If a complete valid block is required to test `acceptBlock()`, construct one whose remaining consensus fields and state transitions are also valid.

If a valid fixture cannot be produced within the task, document the blocker accurately and do not claim valid-PoW acceptance coverage.

### 4. P2P Coverage

Do not claim actual block propagation coverage unless a block is sent through the real P2P reception path and accepted by the receiving node's normal production validation path.

If feasible, use the valid fixture to test successful propagation and an invalid fixture to test rejection. Otherwise, retain an explicit documented coverage gap.

### 5. Preserve Consensus and Repository State

Do not change:
- `POW_LIMIT` or PoW hash construction.
- Difficulty or retarget rules.
- Chain ID, supply, rewards, or halving policy.
- Genesis fields, nonce, or hash.
- `DEV_PARAM_VERSION` or handshake rules.

Do not mine Genesis, activate parameters, commit, push, deploy, or perform destructive Git operations.

Preserve all existing modifications and untracked files.

### 6. Verify and Report

Run:
- Focused PoW tests.
- Chain tests.
- Node and integration tests.
- Full `npm test`.
- `npx tsc --noEmit`.
- `npm run lint`.
- `npm run security:check`.

Inspect the final diff and search for every remaining PoW bypass. Report whether the test bypass is genuinely inaccessible through production APIs, whether valid PoW acceptance was tested, and whether actual P2P block propagation was exercised.

Stop after this task.

Once finished, create a new .md file containing a comprehensive, detailed report of everything that has been accomplished.