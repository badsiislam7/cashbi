Continue working on the existing CashBI project in `/workspaces/codespaces-blank`. Do not recreate the project.

Perform a deep, adversarial technical audit of the current implementation before adding features.

Priorities:
1. Verify that PoW validation is enforced independently by every node and that invalid blocks cannot be accepted.
2. Audit coin issuance, block rewards, maximum supply enforcement, transaction nonces, signatures, gas accounting, and balance conservation.
3. Test blockchain synchronization between independently started nodes, peer discovery, malicious peer messages, invalid chains, forks, and reorganizations.
4. Audit persistence and restart recovery, including corrupted or incomplete ledger files.
5. Identify the exact EVM opcode and behavior coverage. Do not describe the current miniEVM as fully EVM-compatible unless it passes appropriate compatibility tests.
6. Audit cryptography, RPC exposure, denial-of-service risks, and mining resource limits.
7. Add regression tests for every confirmed bug and fix confirmed issues without removing existing functionality.
8. Run the full test suite, type checking, linting, security checks, and end-to-end tests. Report actual commands and results.
9. Separate verified facts from assumptions and untested behavior. Do not claim production readiness without evidence.
10. Do not push to GitHub, deploy, or change permanent mainnet consensus parameters.

First inspect the actual source code and current Git status. Then audit one subsystem at a time, implement justified fixes, and provide a prioritized report of remaining risks.