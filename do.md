# CashBI — Harden PoW Validator Construction and Test Boundaries

Repository: `/workspaces/codespaces-blank`

## Objective

Perform a narrowly scoped security review of the constructor-injected `PowValidator` introduced in the latest PoW repair. Determine whether the current design provides a sufficiently clear production/test boundary, and repair it if necessary.

## 1. Audit Construction Paths

Inspect every `new Blockchain(...)` call and every `PowValidator` reference across production source, tests, CLI, node startup, ledger recovery, mining, and P2P code.

Confirm that all production-created chains always use `verifyHeaderPoW`.

Determine whether any production-reachable constructor or factory allows a caller to inject an always-accepting validator.

Do not rely solely on comments, naming, or the claim that production callers currently omit the option.

## 2. Harden the Boundary if Needed

If arbitrary validator injection is exposed through the normal production constructor, refactor the design to make the production path explicit and safe.

Keep test support separate from normal production construction. Choose the smallest architecture consistent with the existing codebase, and document the boundary.

Do not simply rename the injection option. Do not introduce global mutable state, environment-variable bypasses, or a production fast-PoW mode.

Keep fast tests for chain-validation rules that do not need real mining, while ensuring ordinary production block imports always use actual PoW verification.

## 3. Add Regression Tests

Add tests proving that:

- A production-created `Blockchain` rejects a block with invalid PoW.
- Production node and P2P import paths do not accept a test-only validator.
- Test fixtures used for non-PoW chain validation remain isolated from normal production construction.
- Existing difficulty and target-boundary tests remain intact.

Audit Genesis construction separately. Document its current PoW-validation behavior, but do not change Genesis fields or initialization in this task.

A valid-PoW acceptance vector and real P2P block propagation remain open coverage gaps unless they can be addressed safely without changing consensus rules or spending an impractical amount of time mining. Do not claim those tests exist unless they genuinely do.

## 4. Preserve Consensus and Repository State

Do not change:
- POW_LIMIT or PoW hash construction.
- Difficulty or retarget rules.
- Chain ID 901291.
- Maximum supply of 16,000,000 BIC.
- Reward or halving policy.
- Genesis fields, nonce, or hash.
- DEV_PARAM_VERSION or handshake rules.

Do not mine Genesis, commit, push, deploy, or perform destructive Git operations. Preserve all existing modifications and untracked files.

## 5. Verify

Run:
- Focused PoW and chain tests.
- Node and integration tests.
- Full `npm test`.
- `npx tsc --noEmit`.
- `npm run lint`.
- `npm run security:check`.

Inspect the final diff and report every production construction path, any remaining test-only injection surface, test results, and outstanding valid-PoW/P2P coverage gaps.

Do not claim independent verification beyond checks actually performed.

Stop after this task.

Once finished, create a new .md file containing a comprehensive, detailed report of everything that has been accomplished.