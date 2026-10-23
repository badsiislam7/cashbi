Continue the existing CashBI project in `/workspaces/codespaces-blank`. Do not recreate the project or change permanent mainnet parameters.

## Next milestone: Real two-node integration test

The previous audit reports 48 passing tests. Now verify the actual runtime behavior of two independent CashBI full nodes.

1. Inspect the existing CLI and determine the exact supported commands for starting nodes, configuring data directories, connecting peers, submitting signed transactions, and mining.
2. Start two separate node processes with different data directories and identical development genesis configuration.
3. Confirm that both nodes have the same chain ID and genesis hash.
4. Connect them using the existing P2P protocol. Record whether the connection and handshake actually succeed.
5. Submit a correctly signed transaction to node A and verify that node B receives it.
6. Mine a block with explicit mining consent and verify that both nodes accept the same block and converge on the same best block hash, height, and relevant balances.
7. Stop and restart node B using its existing data directory. Verify ledger recovery and reconnection.
8. Test that a node configured with a different genesis or chain ID is rejected.
9. Capture actual command outputs and exit codes. Do not infer success from unit tests or simulate network results.
10. Add an automated integration test and document the exact reproducible procedure in `docs/testnet-two-nodes.md`.

If this environment cannot support multiple node processes or P2P connectivity, document the blocker and provide the exact manual steps needed to run the test elsewhere.

Run the existing tests, typecheck, lint, and security checks after any code changes.

Preserve existing files and Git history. Do not push, deploy, publish, or claim production readiness. Keep all project work inside `/workspaces/codespaces-blank`.

At the end, report whether the two-node runtime test genuinely passed, with evidence for each step and a list of any remaining blockers.

In `/workspaces/codespaces-blank`, report the actual outcome of the latest requested two-node runtime integration test.

Do not implement new features or modify files yet.

Answer each question with evidence from actual command execution:

1. Did you launch two independent CashBI node processes, or did you only run an automated test using two node objects in one process?
2. What exact commands were used to start each node?
3. What separate data directories and ports did the nodes use?
4. Did the nodes establish an actual TCP P2P connection and complete the handshake?
5. Was a signed transaction submitted to node A and observed in node B's mempool?
6. Was a block mined and independently accepted by both nodes? Provide the resulting block hash and height from each node.
7. Was node B stopped and restarted using the same data directory? Did it recover the same chain tip and reconnect?
8. Was a mismatched genesis or chain ID actually tested and rejected?
9. Provide the exact terminal outputs, exit codes, and relevant test names for each completed step.
10. If any step was not performed, explicitly mark it NOT TESTED. Do not infer runtime success from unit tests, and do not fabricate command output.

Finally, state whether `docs/testnet-two-nodes.md` exists and whether its procedure has been executed end to end.

Do not push, deploy, or change consensus parameters. Preserve the existing project and Git history.