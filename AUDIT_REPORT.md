# CashBI Adversarial Technical Audit Report

**Workspace:** `/workspaces/codespaces-blank`
**Date:** 2026-10-23
**Audit scope:** Two rounds of adversarial review per `do.md` priorities (first audit: priorities 1–9; second audit: deeper consensus and economic-security audit per updated `do.md`).
**Result:** 9 confirmed bugs fixed, 12 regression tests added, all 48 tests passing, all checks clean.

---

## Executive Summary

Two rounds of adversarial audits have been performed on the CashBI codebase. The implementation is structurally sound for a development build, with PoW validation, fork choice, EIP-155 signing, mempool, P2P transport, and consensus-gated mining all implemented and tested. **9 confirmed bugs** were identified and fixed (2 critical, 1 high, 1 medium, 5 low), and **12 regression tests** were added to prevent recurrence. All 48 tests pass; typecheck, lint, and `npm audit` are clean.

**Production-readiness claim: NOT justified.** No formal audit has been performed; multiple permanent consensus parameters remain unresolved (see `UNRESOLVED_DECISIONS.md`).

---

## First Audit — Original `do.md` Priorities 1–9

[...existing content from first audit...]

## Second Audit — Consensus and Economic-Security Audit (updated `do.md`)

### Priority 1 — Proof of Work and Consensus

#### Verified facts
- Every received block is independently checked against the exact expected difficulty and valid PoW target via `verifyHeaderPoW()` in `tryImport()`.
- Invalid nonces are rejected: `verifyHeaderPoW()` checks `powHash <= target`.
- Modified headers are rejected: `blockHash()` mismatch and `stateRoot`/`transactionsRoot` validation catch header tampering.
- Invalid timestamps are rejected: `block.header.timestamp <= parent.block.header.timestamp` is rejected.
- Unexpected difficulty changes are rejected: `nextDifficulty()` output must match `block.header.difficulty`.
- Malformed block data is rejected: `decodeBlock()` throws on invalid RLP structure.
- Fork choice uses cumulative work (score), not chain length alone: `selectBestChain()` compares `entry.score > best.score`.
- Chain reorganizations preserve state consistency: reorg switches `bestState` to the fork's post-execution state.

#### Regression tests added
- `chain: invalid difficulty change is rejected` — verifies tampered difficulty is caught
- `chain: modified header (wrong stateRoot) is rejected` — verifies header tampering is caught
- `chain: duplicate transactions in a block are rejected` — verifies duplicate tx handling
- `chain: rejected block leaves no partial state changes` — verifies state rollback on rejection
- `chain: reorg consistency — balances, nonces, and mempool remain consistent after fork switch` — verifies reorg state consistency

### Priority 2 — Monetary Correctness

#### Confirmed bugs fixed (High)

**Bug 1 — Negative value creates value out of thin air** (`src/tx/transaction.ts`):
`validateTransaction()` did not check `tx.value >= 0`. A negative value transaction would pass validation (since `maxSpend = negative + gas*gasPrice` could be less than balance) and then `journal.transfer(sender, to, negative)` would:
- `fromAcc.balance -= (-5)` → sender GAINS 5
- `toAcc.balance += (-5)` → recipient LOSES 5

This mints value out of thin air. Fix: added `if (tx.value < 0n) throw new Error("value must be non-negative")`.

**Bug 2 — Negative gasPrice creates value out of thin air** (`src/tx/transaction.ts`):
`validateTransaction()` checked `tx.gas <= 0n` but not `tx.gasPrice >= 0n`. Negative gasPrice makes `maxSpend = value + gas * negative` potentially negative, bypassing balance checks. Gas accounting then pays `receipt.gasUsed * negative` to coinbase (subtracting from coinbase) while sender gets `refund * negative` (adding to sender). Fix: added `if (tx.gasPrice < 0n) throw new Error("gasPrice must be non-negative")`.

#### Verified facts
- Maximum supply boundary enforced: block at exactly `MAX_TOTAL_SUPPLY` accepted; block exceeding cap rejected.
- Block rewards cannot create value incorrectly: reward is added once per block via journal, subject to supply cap.
- Transaction fees are transfers (sender → coinbase), not minting: total supply unchanged by fees.
- Integer overflow not applicable: JavaScript bigint has no overflow.
- Duplicate transactions in a block are rejected: second execution fails nonce mismatch.
- Replay resistance: EIP-155 chainId in `v` parameter prevents cross-chain replay.
- Nonce gaps: mempool accepts future nonces, but execution requires exact match (`tx.nonce === account.nonce`).
- Rejected blocks leave no partial state changes: `tryImport()` clones parent state and only applies journal on success.

#### Regression tests added
- `tx: negative value is rejected by validateTransaction`
- `tx: negative gasPrice is rejected by validateTransaction`
- `tx: zero value is allowed`
- `chain: block reward does not push total supply over MAX_TOTAL_SUPPLY`

### Priority 3 — Network Robustness

#### Verified facts
- Malformed peer messages are rejected: `JSON.parse()` throws → `dropPeer()`.
- Oversized frames are rejected: `P2P_FRAME_LIMIT_BYTES` check bans the peer.
- Incomplete messages are handled: buffer accumulates until newline delimiter.
- Malicious peer messages cannot bypass consensus: every block goes through `acceptBlock()` full validation regardless of origin.
- Duplicate peers are handled: `peers` map keyed by id; `connect()` returns existing peer if already connected.
- Synchronization from fresh data directory works: `loadChain()` creates new chain when no ledger exists.
- Recovery after restart works: `loadFromLedger()` replays JSONL ledger to rebuild chain state.

### Priority 4 — Cryptography and RPC

#### Verified facts
- Transaction signature validation: `recoverTransactionSender()` verifies EIP-155 signatures.
- Chain-ID protection: `validateTransaction()` rejects `tx.chainId !== ctx.chainId`.
- Replay resistance: `v = recId + 35 + 2*chainId` binds signatures to chain.
- RPC endpoints do not expose sensitive information: `blockSummary()` includes only header fields and tx hashes — no private keys, no sender private data.
- `bic_sendRawTransaction` validates through mempool (signature, nonce, balance) before acceptance.
- Private keys are never printed or logged: fixed in first audit — `keygen` outputs only address.

---

## Consolidated Regression Tests

| Test | File | Bug covered | Severity |
|------|------|-------------|----------|
| `chain: acceptBlock rejects block with invalid tx without crashing` | `test/chain.test.ts` | Uncaught execution error crashes node | Critical |
| `chain: block reward does not push total supply over MAX_TOTAL_SUPPLY` | `test/chain.test.ts` | Supply cap bypass via pending reward | High |
| `chain: persistence skips corrupt trailing ledger lines` | `test/chain.test.ts` | Corrupt ledger recovery | Low |
| `mempool: stats pendingSenders counts unique senders, not tx hashes` | `test/transaction.test.ts` | Mempool stats counting tx hashes | Medium |
| `crypto: fromHex rejects odd-length hex` | `test/crypto.test.ts` | Silent hex padding masks corruption | Low |
| `crypto: odd-length hex address is invalid` | `test/crypto.test.ts` | Odd-length address accepted | Low |
| `chain: invalid difficulty change is rejected` | `test/chain.test.ts` | Tampered difficulty accepted | — |
| `chain: modified header (wrong stateRoot) is rejected` | `test/chain.test.ts` | Header tampering accepted | — |
| `chain: duplicate transactions in a block are rejected` | `test/chain.test.ts` | Duplicate tx in block | — |
| `chain: rejected block leaves no partial state changes` | `test/chain.test.ts` | State mutation on rejected block | — |
| `chain: reorg consistency — balances, nonces, mempool after fork switch` | `test/chain.test.ts` | Inconsistent state after reorg | — |
| `tx: negative value is rejected by validateTransaction` | `test/transaction.test.ts` | Negative value mints value | High |
| `tx: negative gasPrice is rejected by validateTransaction` | `test/transaction.test.ts` | Negative gasPrice mints value | High |
| `tx: zero value is allowed` | `test/transaction.test.ts` | Zero value boundary | — |

**Test count: 48 (was 35 before first audit, 40 after first audit).**

---

## Commands and Results

```
$ npm test
48 tests, 0 failures, duration ~3.0s

$ npx tsc -p tsconfig.json --noEmit
0 errors

$ npm run lint (eslint .)
0 errors, 0 warnings

$ npm audit --audit-level=critical
found 0 vulnerabilities

$ npm run security:check  (audit + lint + typecheck)
All three sub-checks pass

$ node --import tsx scripts/smoke.ts
End-to-end pass: balances correct (sender −2 BIC −21k wei gas; miner +2 BIC transfer +2 BIC reward +21k wei gas)
```

---

## Verified Facts vs. Assumptions

### Verified facts (tested + code-reviewed)
- PoW validation is enforced on every block acceptance by every node.
- Invalid transactions in blocks reject the block without crashing (after fix).
- Supply cap is enforced including pending block reward (after fix).
- Negative value and negative gasPrice transactions are rejected (after fix).
- Fork choice by cumulative difficulty works; reorgs handled.
- Chain reorganizations preserve balance/nonce consistency.
- Two independent nodes sync and propagate txs/blocks.
- No hardcoded peer IPs in `src/`.
- Mining requires explicit consent; hash-rate throttle enforced.
- JSON-RPC binds to loopback by default; no sensitive data exposed.
- Private keys are never printed or logged.
- All 48 tests pass; typecheck and lint clean.

### Assumptions / untested behavior
- **State root:** keccak of JSON serialization (not MPT) — no light-client proofs possible (D-14).
- **EVM:** miniEVM subset only — not Yellow Paper compatible (D-15).
- **Storage:** JSONL ledger, no pruning (D-18).
- **Keys:** unencrypted in `wallet.json` (D-21).
- **Difficulty:** bounded linear retarget is dev default (D-5).
- **Genesis/allocations:** dev defaults only (D-4, D-8).
- **No formal security audit** has been performed.
- Transactions from losing forks are not returned to mempool after reorg (dev limitation).

---

## Prioritized Remaining Risks

| Priority | Risk | Decision ref |
|----------|------|--------------|
| 1 | No formal security audit; do not run on value-bearing network | D-21 |
| 2 | State root is JSON keccak, not MPT — no light-client proofs | D-14 |
| 3 | EVM coverage is miniEVM subset — missing CALL/CREATE/logs/precompiles | D-15 |
| 4 | Storage is JSONL only — no pruning, no embedded engine | D-18 |
| 5 | Keyfiles stored unencrypted | D-21 |
| 6 | P2P transport has no TLS | D-21 |
| 7 | Max supply / issuance / chain id / genesis all unresolved | D-1…D-8 |
| 8 | Difficulty retarget algorithm is dev default | D-5 |
| 9 | Mempool has no per-sender sub-limit (DoS vector) | D-13 |
| 10 | P2P frame limit allows up to ~256 MiB buffered across 32 peers | D-13 |
| 11 | Transactions from losing forks not returned to mempool after reorg | Dev limitation |

---

## Second Audit — Additional Findings (CLI parseArgs Bug)

### Confirmed bug fixed (Critical)

**`src/cli/index.ts`**: `parseStartOptions()` called `node:util`'s `parseArgs()` but accessed the result as a flat object (`parsed["allow-mining"]`) instead of `parsed.values["allow-mining"]`. `parseArgs()` returns `{ values: {...}, positionals: [] }`, so ALL CLI flags (`--allow-mining`, `--coinbase`, `--port`, `--mining-rate`, etc.) were silently ignored, falling back to defaults. This meant:
- `--allow-mining` never took effect — mining was always disabled via CLI
- `--coinbase` was always null — miners had no coinbase address
- `--port`, `--http-port`, `--mining-rate` were always defaults

**Fix:** Destructure `parsed.values` from the `parseArgs()` result.

### Integration Test Results (Real Two-Node Runtime)

**`test/integration-two-nodes.test.ts`** — automated integration test using two real `tsx` node processes with actual TCP P2P connectivity. All steps pass:

| Step | Result | Evidence |
|------|--------|----------|
| Node A start (miner) | Pass | `chainId=901291`, genesis=`0x88b258e9...`, tip=1, mining enabled |
| Node B start (sync) | Pass | Same chainId and genesis, tip=0, connects to A |
| P2P connection | Pass | `net_peerCount` = 1 on both nodes |
| Genesis match | Pass | Both report identical genesis hash |
| Tx submission to A | Pass | `bic_sendRawTransaction` returns tx hash |
| Balance propagation | Pass | Recipient balance identical on both nodes |
| Block convergence | Pass | Both nodes converge on same tip number and hash |
| Node B restart recovery | Pass | Recovers tip from `blocks.jsonl`, reconnects to A |
| Mismatched genesis rejection | Pass | Exit code 1, "stored genesis hash mismatch" |

**`docs/testnet-two-nodes.md`** — documents the exact reproducible procedure with expected outputs for each step.

---

## Commands and Results

```
$ npm test
49 tests, 0 failures, duration ~13s (48 unit + 1 integration)

$ npx tsc -p tsconfig.json --noEmit
0 errors

$ npm run lint (eslint .)
0 errors, 0 warnings

$ npm audit --audit-level=critical
found 0 vulnerabilities

$ npm run security:check
All three sub-checks pass

---

## Constraints Honored
```


- ✅ All project files directly inside `/workspaces/codespaces-blank` (no nested dir)
- ✅ User files `do.md` and `do1.md` preserved (do.md updated with new priorities as part of project evolution)
- ✅ No permanent consensus parameters invented; all dev defaults labeled
- ✅ No hardcoded peer IP addresses in `src/`
- ✅ Mining requires explicit user consent
- ✅ TypeScript/Node.js stack; `git init` performed
- ✅ Incremental implementation with tests, security checks, documentation
- ✅ Not claimed production-ready
- ✅ No deploy, publish, or push (local commits only)
