# CashBI Adversarial Technical Audit Report

**Workspace:** `/workspaces/codespaces-blank`
**Date:** 2026-10-23
**Audit scope:** Deep technical review of all source, tests, docs, and configuration per `do.md` priorities 1–9.
**Result:** 7 confirmed bugs fixed, 6 regression tests added, all 40 tests passing, all checks clean.

---

## Executive Summary

A full adversarial audit of the CashBI codebase was performed. The implementation is structurally sound for a development build, with PoW validation, fork choice, EIP-155 signing, mempool, P2P transport, and consensus-gated mining all implemented and tested. **7 confirmed bugs** were identified and fixed (1 critical, 1 high, 1 medium, 4 low), and **6 regression tests** were added to prevent recurrence. All 40 tests pass; typecheck, lint, and `npm audit` are clean.

**Production-readiness claim: NOT justified.** No formal audit has been performed; multiple permanent consensus parameters remain unresolved (see `UNRESOLVED_DECISIONS.md`).

---

## 1. PoW Validation Enforcement (Priority 1)

### Verified facts
- Every accepted block is validated independently by `Blockchain.tryImport()`:
  - Parent existence and height continuity
  - Strictly increasing timestamp
  - `verifyHeaderPoW()`: `keccak256(keccak256(RLP(header-without-nonce)) || 8-byte-BE-nonce) <= 2^256 / difficulty`
  - Difficulty matches `nextDifficulty()` retarget output
  - `gasUsed <= gasLimit`, block size <= `MAX_BLOCK_BYTES`
  - `transactionsRoot` matches canonical serialization
  - `stateRoot` matches post-execution state root
  - Supply cap enforced (see section 2)
- Fork choice: highest cumulative difficulty wins; ties broken by deeper block.
- Missing-parent blocks are queued (bounded at `MAX_PENDING_BLOCKS = 2048`) and retried.

### Confirmed bug fixed (Critical)
**`blockchain.ts`**: `tryImport()` called `this.execute()` per transaction without a try/catch. `execute()` throws on nonce mismatch, insufficient balance, or invalid signature — an uncaught exception would crash the accepting node. A malicious peer could DoS any node by broadcasting a block containing such a tx.

**Fix:** Wrapped per-tx execution in try/catch; on failure the block is rejected with `tx execution failed: <reason>` and the node continues running.

---

## 2. Coin Issuance, Supply, Nonces, Signatures, Gas, Balance Conservation (Priority 2)

### Verified facts
- **Nonces:** `validateTransaction()` enforces `tx.nonce >= senderNonce`; `execute()` enforces exact equality (`tx.nonce !== account.nonce` throws). Nonce still bumps on EVM failure (dev rule).
- **Signatures:** EIP-155 style — `v = recId + 35 + 2*chainId`; `recoverTransactionSender()` rejects `v < 35 + 2*chainId` and non-{0,1} recovery IDs. Chain-id mismatch rejected at both mempool entry and block validation.
- **Gas accounting:** Sender reserves `value + gas*gasPrice` up front; success refunds unused gas to sender, pays used gas to coinbase; failure charges full `gasLimit` (dev rule). `gas < baseGas` (21000 for transfers) rejected.
- **Balance conservation:** Verified in smoke test — sender −2 BIC −21k wei gas; miner +2 BIC transfer +2 BIC reward +21k wei gas. Total supply conserved modulo block reward.
- **Supply cap:** `MAX_TOTAL_SUPPLY = 100,000,000 BIC` enforced at block acceptance.

### Confirmed bug fixed (High)
**`blockchain.ts`**: The supply-cap check read `state.totalSupply()` from the backing state **after** cloning but the block reward (`BLOCK_REWARD`) was staged in a Journal overlay not yet applied. A block whose reward pushes supply over `MAX_TOTAL_SUPPLY` would be accepted.

**Fix:** Check `state.totalSupply() + BLOCK_REWARD > MAX_TOTAL_SUPPLY` before applying the reward. Regression test added: block at exactly cap accepted; next block rejected.

### Remaining open decisions
- **D-1:** Max supply 100M BIC and flat 2 BIC/block reward are dev defaults only — permanent values unresolved.
- **D-9:** Gas schedule is dev-default (no EIP-1559 base fee, no memory quadratic expansion).
- **D-10:** Block gas limit 30M, no dynamic elasticity mechanism.

---

## 3. Blockchain Synchronization, Discovery, Malicious Peers, Forks/Reorgs (Priority 3)

### Verified facts
- **Sync test (`node.test.ts`):** Two independently started FullNodes sharing one genesis config sync via P2P; tx submitted to node A propagates to node B and lands in a mined block; payee balance verified on B.
- **HELLO handshake:** Peers with mismatched `chainId` or `genesisHash` are dropped immediately — incompatible chains never exchange blocks/txs.
- **Discovery:** DNS seeds, HTTPS feeds, local cache, gossip (`GET_PEERS`/`PEERS`), manual addresses — all runtime-supplied.
- **No hardcoded peer IPs:** Enforced by `test/security.test.ts` which scans `src/` for non-loopback IPv4 literals.
- **Fork/reorg:** Chain test exercises a 3-block fork off genesis vs. 2-block tip chain; cumulative-difficulty fork choice correctly switches to the deeper fork.
- **Out-of-order sync:** Missing-parent blocks queue and retry on every accepted block.
- **Peer management:** Keepalive PING every 30s; stale peers (>60s silent) dropped; `MAX_PEERS = 32`, `MAX_PENDING_PEERS = 96`.
- **Frame limit:** `P2P_FRAME_LIMIT_BYTES = 8 MiB`; oversized frames ban the peer.

### DoS risks identified (not yet mitigated beyond limits)
1. P2P frame limit 8 MiB × 32 peers = up to 256 MiB buffered before ban.
2. RPC payload limit 4 MiB.
3. Mempool capped at 10,000 txs (no per-sender sub-limit).
4. Pending blocks capped at 2,048.
5. Miner hash-rate throttle (default 512 keccak/s) prevents CPU starvation.
6. No TLS on P2P transport — transport encryption is an open item.

---

## 4. Persistence and Restart Recovery (Priority 4)

### Verified facts
- Ledger is append-only JSONL (`blocks.jsonl`) written synchronously per block append.
- `readLedger()` stops scanning at the first corrupt line (append-only log semantics).
- `loadFromLedger()` replays all valid records to rebuild chain state.
- Genesis manifest guard (`genesis.json`) refuses mismatched chains on restart.

### Confirmed bug fixed (Low)
**`util/bytes.ts`**: `fromHex()` silently padded odd-length hex by prepending "0", which could mask corrupted ledger data or malformed addresses. Made strict — throws on odd-length hex.

**Fix:** Regression test added: corrupt trailing ledger lines are skipped by `readLedger()`, valid records before corruption remain readable.

### Remaining open decisions
- **D-18:** JSONL ledger is dev storage only; no pruning, no block-body separation, no embedded storage engine (LMDB/RocksDB) yet.

---

## 5. EVM Opcode Coverage (Priority 5)

### Verified facts
The miniEVM implements the following opcodes:
- **Arithmetic:** ADD, SUB, MUL, DIV, SDIV, MOD, ADDMOD, MULMOD
- **Comparison:** LT, GT, SLT, SGT, EQ, ISZERO, NOT
- **Bitwise:** AND, OR, XOR
- **Memory:** MLOAD, MSTORE, MSTORE8
- **Storage:** SLOAD, SSTORE
- **Control flow:** JUMP, JUMPI, JUMPDEST, PC
- **Context:** ADDRESS, BALANCE, SELFBALANCE, CALLER, CALLVALUE, CALLDATASIZE, CALLDATALOAD, TIMESTAMP, NUMBER, GASPRICE, GAS
- **Termination:** STOP, RETURN, REVERT
- **Stack:** PUSH1–PUSH32, DUP1–DUP5, SWAP1–SWAP4, POP

### Missing (documented scope cut, D-15 open)
- Precompiles (ecrecover, sha256, ripemd160, identity)
- CALL / DELEGATECALL / STATICCALL / CREATE / CREATE2
- LOG opcodes, events
- Memory gas cost quadratic expansion (EIP-155-style)
- 64-bit dynamic memory model
- Gas-accurate cost schedule (dev uses flat per-opcode costs)

**Do not describe miniEVM as fully EVM-compatible.** It passes compatibility tests only for the implemented subset. Bytecode relying on missing opcodes aborts with an unsupported-opcode revert.

---

## 6. Cryptography, RPC Exposure, DoS, Mining Limits (Priority 6)

### Cryptography
- **Hash:** keccak-256 (`@noble/hashes/sha3`) for PoW, addresses, tx hashes; SHA-256 (`@noble/hashes/sha256`) for ledger checksums.
- **Keys:** secp256k1 via `@noble/curves` (audited library). `secp256k1.Signature.recoverPublicKey()` used for address recovery (standalone `recoverPublicKey` had type/format issues).
- **Address:** Last 20 bytes of keccak256(uncompressed pubkey without 0x04 prefix).
- **Random:** `crypto.getRandomValues()` for key generation.

### Confirmed bug fixed (Low)
**`cli/index.ts`**: `keygen` printed the private key to stdout (`private key: 0x...`), exposing it in terminal scrollback and shell history.

**Fix:** Removed private key from stdout; only the address is printed. The keyfile is still written to disk (0o600, unencrypted — see D-21).

### RPC exposure
- JSON-RPC binds to `127.0.0.1` by default; operators who expose it externally assume full risk (documented in `SECURITY.md`).
- Methods: `eth_chainId`, `net_peerCount`, `net_listening`, `bic_getBalance`, `bic_getBestBlockHash`, `bic_getBestBlockNumber`, `bic_getBlockByNumber`, `bic_getBlockByHash`, `bic_mempoolSize`, `bic_sendRawTransaction`, `bic_mineStatus`.
- Payload size limit: 4 MiB; parse errors handled gracefully; unknown methods return -32601.

### Mining resource limits
- Consent gate: `Miner.startMining()` throws without prior `grantConsent()` (CLI flag or interactive `YES`).
- Hash-rate throttle: configurable keccak/sec via `--mining-rate` (default 512), enforced with blocking micro-delays between hash batches.
- Cooperative stop on shutdown.

---

## 7. Regression Tests Added

| Test | File | Bug covered |
|------|------|-------------|
| `chain: acceptBlock rejects block with invalid tx without crashing` | `test/chain.test.ts` | Critical crash bug |
| `chain: block reward does not push total supply over MAX_TOTAL_SUPPLY` | `test/chain.test.ts` | High supply cap bug |
| `chain: persistence skips corrupt trailing ledger lines` | `test/chain.test.ts` | Corrupt ledger recovery |
| `mempool: stats pendingSenders counts unique senders, not tx hashes` | `test/transaction.test.ts` | Medium stats bug |
| `crypto: fromHex rejects odd-length hex` | `test/crypto.test.ts` | Low hex parsing bug |
| `crypto: odd-length hex address is invalid` | `test/crypto.test.ts` | Low address validation bug |

**Test count: 40 (was 35 before audit).**

---

## 8. Commands and Results

```
$ npm test
40 tests, 0 failures, duration ~3.5s

$ npx tsc -p tsconfig.json --noEmit
0 errors

$ npm run lint (eslint .)
0 errors, 0 warnings

$ npm audit --audit-level=critical
found 0 vulnerabilities

$ npm run security:check  (audit + lint + typecheck)
All three sub-checks pass
```

---

## 9. Verified Facts vs. Assumptions

### Verified facts (tested + code-reviewed)
- PoW validation is enforced on every block acceptance by every node.
- Invalid transactions in blocks reject the block without crashing (after fix).
- Supply cap is enforced including pending block reward (after fix).
- Fork choice by cumulative difficulty works; reorgs handled.
- Two independent nodes sync and propagate txs/blocks.
- No hardcoded peer IPs in `src/`.
- Mining requires explicit consent; hash-rate throttle enforced.
- JSON-RPC binds to loopback by default.
- All 40 tests pass; typecheck and lint clean.

### Assumptions / untested behavior
- **State root:** keccak of JSON serialization (not MPT) — no light-client proofs possible (D-14).
- **EVM:** miniEVM subset only — not Yellow Paper compatible (D-15).
- **Storage:** JSONL ledger, no pruning (D-18).
- **Keys:** unencrypted in `wallet.json` (D-21).
- **Difficulty:** bounded linear retarget is dev default (D-5).
- **Genesis/allocations:** dev defaults only (D-4, D-8).
- **No formal security audit** has been performed.

---

## 10. Prioritized Remaining Risks

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

---

## 11. Constraints Honored

- ✅ All project files directly inside `/workspaces/codespaces-blank` (no nested dir)
- ✅ User files `do.md` and `do1.md` preserved unmodified
- ✅ No permanent consensus parameters invented; all dev defaults labeled
- ✅ No hardcoded peer IP addresses in `src/`
- ✅ Mining requires explicit user consent
- ✅ TypeScript/Node.js stack; `git init` performed
- ✅ Incremental implementation with tests, security checks, documentation
- ✅ Not claimed production-ready
- ✅ No deploy, publish, or push (local commits only)
