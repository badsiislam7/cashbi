Continue the existing CashBI project in `/workspaces/codespaces-blank`. Preserve all existing files, tests, and Git history.

The initial implementation and first audit are complete. Now perform a second, deeper consensus and economic-security audit.

Priority 1 — Proof of Work and consensus:
- Verify that every received block is independently checked against the exact expected difficulty and valid PoW target.
- Test invalid nonces, modified headers, invalid timestamps, unexpected difficulty changes, and malformed block data.
- Verify fork choice using cumulative work rather than chain length alone.
- Test chain reorganizations and confirm that account balances, transaction nonces, and mempool contents remain consistent.

Priority 2 — Monetary correctness:
- Test the maximum supply boundary under normal blocks, competing forks, and reorganizations.
- Verify that block rewards and transaction fees cannot create value incorrectly.
- Test integer overflow, negative values, invalid amounts, duplicate transactions, replay attempts, and nonce gaps.
- Ensure rejected blocks leave no partial state changes.

Priority 3 — Network robustness:
- Test malformed, oversized, incomplete, and malicious peer messages.
- Verify that a peer cannot make the node accept invalid blocks or bypass consensus validation.
- Test reconnection, duplicate peers, synchronization from a fresh data directory, and recovery after restart.

Priority 4 — Cryptography and RPC:
- Verify transaction signature validation, chain-ID protection, and replay resistance.
- Check whether RPC endpoints expose sensitive information or permit unsafe actions without authorization.
- Ensure private keys are never printed or logged.

Requirements:
1. Inspect the actual implementation before making changes.
2. Add a regression test for every confirmed bug.
3. Fix only issues supported by code inspection or reproducible tests.
4. Run the complete test suite, TypeScript checks, lint, security checks, and smoke tests.
5. Update `AUDIT_REPORT.md` with verified findings, severity, reproducible evidence, fixes, and unresolved risks.
6. Do not claim full EVM compatibility; document the exact limitations of the current MiniEVM.
7. Do not finalize mainnet consensus parameters, deploy, publish, or push to GitHub.
8. Finish with a concise report of files changed, tests run, results, and remaining critical risks.

Do not recreate the project. Work only in `/workspaces/codespaces-blank`.