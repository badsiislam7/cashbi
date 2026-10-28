# CashBI — Audit and Isolate the Test-Only PoW Bypass

## Objective

Audit and repair the PoW validation bypass introduced during the previous test-repair task. Ensure that production block-import and P2P paths can never accidentally bypass proof-of-work validation, while keeping the test suite fast and deterministic.

Repository: `/workspaces/codespaces-blank`

## 1. Inspect Before Editing

Inspect the current working tree and the exact implementations of:

- `src/chain/blockchain.ts`
- `src/consensus/pow.ts`
- `src/mining/miner.ts`
- `src/net/server.ts`
- `test/pow.test.ts`
- `test/chain.test.ts`
- `test/node.test.ts`
- `test/integration-two-nodes.test.ts`

Search for every occurrence of `skipPoWValidation`, `acceptBlock`, `tryImport`, and every P2P block-reception handler.

Preserve all existing user changes. Do not reset, clean, stash, revert, or overwrite unrelated modifications.

## 2. Remove the Production Bypass

Remove `skipPoWValidation` from the public production `acceptBlock()` API and from any production import API that can bypass PoW.

Production block imports must always verify the header PoW. This requirement applies to every ordinary block-import path, including externally received P2P blocks.

If tests need to bypass PoW for testing other validation rules, isolate that capability in a clearly test-only fixture or helper that production node and networking code cannot accidentally invoke.

Do not merely rename the bypass flag or leave an equivalent public production bypass.

If the project architecture cannot safely isolate this test-only behavior without a larger redesign, stop and report the blocker rather than weakening production validation.

## 3. Add Deterministic PoW Acceptance and Rejection Tests

Add or retain tests that demonstrate all of the following:

- A known, independently verified valid PoW header is accepted by the normal production validation path.
- An invalid nonce/header is rejected by the normal production block-import path.
- P2P-received blocks cannot bypass PoW validation.
- Existing difficulty, target-boundary, target-exceeded, and invalid-difficulty tests remain intact.

Use a precomputed valid PoW test vector with its exact header fields, nonce, digest, target, and expected result documented. Verify the vector using the actual consensus implementation and, where practical, an independent calculation or verification script.

Do not run billions of hashes in unit tests. Do not claim that nonce `0` is valid without verifying the complete header against the actual target.

## 4. Repair Integration-Test Coverage

The current integration test verifies startup, handshake, transaction submission, restart recovery, reconnection, and mismatched-genesis rejection. It does not currently prove actual block propagation.

Update the tests so their claims match what they exercise.

Where feasible, test actual block propagation between two nodes using a deterministic valid PoW fixture or a test network configuration that does not alter production consensus parameters.

Any test-only fixture or network configuration must be isolated from production defaults and must not silently introduce a consensus bypass.

Verify that the receiving node validates the block through its normal production P2P import path.

If genuine propagation cannot be tested safely within this task, clearly document the gap and do not claim propagation coverage.

## 5. Preserve Consensus Decisions

Do not change:

- `POW_LIMIT` or its compact representation.
- The PoW hash construction or byte order.
- Difficulty calculation or retarget rules.
- Chain ID `901291`.
- Maximum supply of `16,000,000 BIC`.
- Block reward or halving policy.
- Genesis fields, nonce, or hash.
- `DEV_PARAM_VERSION`.
- Handshake compatibility rules.

Do not mine Genesis, update Genesis hashes, activate new consensus parameters, or undertake unrelated consensus redesign.

Do not introduce a production fast-PoW mode or weaken validation to make tests pass.

## 6. Verify

Run and report the actual results of:

1. Focused PoW tests.
2. Chain tests.
3. Node and two-node integration tests.
4. Full `npm test`.
5. `npx tsc --noEmit`.
6. `npm run lint`.
7. `npm run security:check`.

Inspect the final diff and search again for all PoW bypasses. Confirm that no production API or network path can disable PoW validation.

Report separately:
- Tests that genuinely exercise production PoW validation.
- Tests that use isolated test fixtures.
- Whether actual P2P block propagation was tested.
- Any remaining limitations.
- All modified and untracked files.

Do not commit, push, deploy, or perform destructive Git operations. Preserve the current working tree and all pre-existing changes.

Stop after this audit and repair task.

Once finished, create a new .md file containing a comprehensive, detailed report of everything that has been accomplished.