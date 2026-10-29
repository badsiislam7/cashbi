# CashBI — Report: Genesis PoW Activation Readiness Audit

**Task:** `/workspaces/codespaces-blank/do.md` — "Genesis PoW Activation Readiness Audit"
**Date:** 2026-10-29
**Git state:** HEAD `a10c18cc7c5050992bcea7f3b6336ce05d46f878` (= `origin/main`) — **no commits, no pushes, no production code changes**
**Deliverable:** this readiness plan. **No genesis was mined and no startup validation was implemented in this task.**

---

## 1. Verified current state (evidence, not assumptions)

### 1.1 Commands run (read-only inspection + verification)

| Command / action | Result |
|---|---|
| `git status --short`, `git rev-parse HEAD` | HEAD `a10c18c…`; working tree `M do.md`, `M test/pow.test.ts` (both iterations' uncommitted test work preserved), 5 deleted prior report files (environment deletions, preserved), no untracked reports besides this one |
| Read `src/chain/genesis.ts`, `src/chain/block.ts`, `src/chain/blockchain.ts`, `src/consensus/pow.ts`, `src/config/params.ts`, `src/node/node.ts`, `src/net/server.ts`, `src/mining/miner.ts`, `src/cli/index.ts`, `test/genesis.test.ts`, `test/handshake.test.ts`, docs | completed |
| Production genesis hash via `blockHash(buildGenesis(emptyGenesisConfig(0)).header)` | `0x88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b` ✓ matches all pins |
| **Independent reproduction** (no project code): header fields hand-RLP-encoded in a Python script per the Ethereum RLP spec → 150-byte list with outer prefix `0xf8 0x94`; Keccak-256 via **PyCryptodome** gave header preimage digest `cec2e2826d5cd253442799f2d55fec9bf3264d9d772328de250624e126983209`; appending the 8-byte BE nonce `0x0000000000000000` and keccak-hashing again gave **exactly** `88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b` | **MATCH — full genesis hash independently reproduced** |
| `verifyHeaderPoW(genesisHeader, { nonce: 0n })` | `{ ok: false, hash: "0x", reason: "PoW hash above target (difficulty 1)" }` — **the current genesis does NOT satisfy PoW under POW_LIMIT** (its nonce-0 digest is `0x336d4347…5098438`, ~254 bits, far above the 2^224 boundary). Genesis currently bypasses this check because the `Blockchain` constructor injects the block directly (no `tryImport`/`checkPoW` call). |
| `npm test` | **99/99 pass** (~13 s) — baseline recorded |
| Short throughput measurement of the real mining hash (single script, 200,000 `powHash` evaluations, **not** a mining job, no Miner class started) | **24,409 H/s** (single thread; 8.19 s for 200k) |

### 1.2 Genesis header fields and serialization order (task §3)

From `src/chain/genesis.ts` (`genesisHeader`, `emptyGenesisConfig(0)`) and `src/chain/block.ts` (`headerFieldsForRLP`), the exact field order inside `RLP.encode([...])`:

| # | Field | Value (current dev genesis) | Encoding |
|---|---|---|---|
| 1 | `parentHash` | `0x` + 32 × `00` | 32-byte string |
| 2 | `number` | `0` | project `minimalBytes(0)` = `[0x00]` (dev-simplification convention; NOT spec `RLP(0)=0x80` — intentional, unchanged) |
| 3 | `timestamp` | `0` | `[0x00]` |
| 4 | `difficulty` | `1n` (GENESIS_DIFFICULTY) | `[0x01]` |
| 5 | `coinbase` | `0x` + 20 × `00` | 20-byte string |
| 6 | `extraData` | `"cashbi-dev-genesis"` (17 bytes) | ASCII bytes |
| 7 | `gasLimit` | `30_000_000n` (MAX_BLOCK_GAS) | `[0x83, 0x01, 0xC9, 0xC3, 0x80]` |
| 8 | `gasUsed` | `0n` | `[0x00]` |
| 9 | `transactionsRoot` | `keccak256(rlp([]))` = `0x1dcc4de8…d49347` (published Ethereum empty-list hash; independently reconfirmed with PyCryptodome) | 32-byte string |
| 10 | `stateRoot` | allocation-set root: `0x518674ab…a73d70` (empty allocation set) | 32-byte string |
| — | `nonce` (excluded from preimage) | `0n` currently | 8-byte big-endian, appended to the keccak preimage digest, double role: inside `blockHash = keccak256(preimage ‖ nonceLE?—no: nonceBE)` and inside `powHash = SHA-256(SHA-256(preimage ‖ nonceBE))` |

Header RL list payload = 150 bytes → outer prefix `0xf8 0x94`. Block identity = `keccak256(preimage ‖ 8-byte BE nonce)`. **Verified end-to-end independently** (§1.1).

### 1.3 Mining-work estimate (task §7) — no mining was started

| Quantity | Value (measured this session) |
|---|---|
| Target at genesis difficulty 1 | `POW_LIMIT = 0x00000000ffff0000…0000` (Bitcoin mainnet difficulty-1 limit, compact `0x1d00ffff`) |
| Expected hashes per valid nonce | `(2^256)/(POW_LIMIT+1)` = **4,295,032,833** (≈ 2^32.00002; textbook "difficulty 1 ≈ 2^32") |
| Measured `powHash` implementation rate | **24,409 H/s single thread** (Node 24, tsx untranspiled loop) |
| Mean time to a valid genesis nonce | **≈ 48.9 h** single thread; **≈ 50.3 h** at the previously observed two-thread rate (~23.7 kH/s) |
| Time for 95% chance | ≈ 3× mean ≈ **147 h** single-thread equivalent |
| Nonce search space | uint64 (8-byte BE) — no exhaustion risk |

Conclusion: obtaining a valid genesis nonce is feasible but requires a sanctioned long-run mining session (~2+ days at current throughput, or additional threads/cores). **This task did not begin mining.**

---

## 2. How the new genesis would be pinned and validated (task §5)

### 2.1 Pinning (design, not yet implemented)

- The genesis nonce would be pinned **only in `genesisHeader()` in `src/chain/genesis.ts`** (currently `nonce: 0n` → would become `nonce: <minedNonce>`). Nothing else in the header may change, or the preimage (and therefore the work already done on it) changes with it. A mined nonce is only valid for the exact preimage it was derived from — the pinning commit must not alter any other field.
- The new genesis hash then follows deterministically; `genesisManifest()` (chainId, genesisHash, genesisTimestamp, paramVersion "0.0.1-dev", allocationCount) picks it up automatically, as do the CLI banner (`cashbi node started: chainId=… genesis=…`) and the P2P `HELLO`.

### 2.2 Startup validation (design, not yet implemented)

Current protection is the **`genesis.json` manifest guard** in `Node.loadChain()` (`src/node/node.ts:118-142`): on restart the stored manifest hash is compared against the re-derived genesis hash; mismatch = hard error ("stored genesis hash mismatch — refusing to continue on a different chain"). Genesis itself is NEVER reconstructed from the ledger; it is re-derived from config each start, so a pinned-nonce change is inherently tamper-evident at manifest-compare time.

Proposed addition (single guarded check, fail-fast):

- In the `Blockchain` constructor (or immediately after `buildGenesis` in `loadChain`), call the existing production `verifyHeaderPoW(genesis.header, { nonce: genesis.header.nonce })`. On `ok: false` → throw and refuse startup. No bypass, no constructor injection, no fallback: a mis-pinned nonce can only be caused by an editing error, and starting a worthless-of-work genesis must stop the node loudly.
- Genesis never flows through `tryImport()/acceptBlock()` (it is injected in the constructor), so this check must live at construction time; the `checkPoW()` production path remains untouched for blocks ≥ 1.

### 2.3 Parameter-version coupling (locked decisions)

`DEV_PARAM_VERSION` stays `"0.0.1-dev"` **until activation**, then bumps in the same coordinated change-set: the genesis re-mine is owner-approved, and the activation review decides the bump. Handshake enforcement already requires byte-exact `paramVersion` equality and note that **the genesis header does not encode consensus parameters** (`test/handshake.test.ts` documents this) — so a genesis hash change does not, by itself, signal a rule change; the version bump is what makes cross-version peers refuse to handshake.

---

## 3. Expected behavior per data-directory/peer scenario (task §6)

| Scenario | Expected behavior after activation commit lands |
|---|---|
| **Fresh data directory** | `loadChain` derives the new genesis (pinned nonce), startup PoW validation passes, writes `genesis.json` (new hash) + empty `blocks.jsonl`; first retarget anchors unaffected (`virtualAnchorTimestamp` depends only on `config.timestamp`, which stays 0; the genesis *hash* is not a retarget input). |
| **Directory containing the OLD genesis** | Re-derived hash (new) ≠ stored manifest hash (old `0x88b2…`) → **hard error, exit before any sync or mining**. `blocks.jsonl` from the old chain is never silently re-imported — there is no migration; this is the locked decision ("new chain launch, no migration"). Only a conscious operator action (delete/archive the datadir) starts a fresh chain. |
| **Directory containing the NEW genesis** | Manifest matches; chain resumes; startup PoW validation passes; normal operation. |
| **Genesis header with invalid PoW** | Startup genesis validation (`verifyHeaderPoW`) fails → node refuses to start with a clear reason (e.g. "pinned genesis nonce does not satisfy POW_LIMIT"). Mis-pinned nonce, corrupted `genesis.ts`, or a wrong `emptyGenesisConfig` field all surface this way. Prefers fail-fast over any silent fallback. |
| **Peer presenting a different genesis hash** | Existing `HELLO` check (`src/net/server.ts:196`): chainId + genesisHash mismatch → peer dropped immediately, no further messages. Old-chain peers and new-chain peers can never connect. |
| **Peer presenting a different `paramVersion`** | Existing `HELLO` check (`server.ts:208`): exact string equality required; missing/malformed/different → dropped. During the activation window, un-bumped nodes (old genesis, `"0.0.1-dev"`) and bumped nodes (new genesis, new version) fail **both** checks — doubly refused. |

---

## 4. Required implementation steps and dependencies (task §2/§8 plan)

Ordered; every step lands in **one authorized activation commit** (with one exception noted). Owner-approved backlog; awaiting a task that explicitly authorizes execution.

1. **Pre-step (separately authorized, before the activation commit): sanctioned mining run** to obtain the nonce: consented multi-thread mining on the frozen genesis preimage with checkpointing (periodically save tried-range/last nonce + candidate header hex to a scratch file), expected ≈ 2-3 days wall-clock at current single-thread rate. Stop as soon as `powHash(header, nonce) <= POW_LIMIT`. **Do not** reuse any nonce found without bitwise re-verification via `verifyHeaderPoW` (production path) AND the independent Python path (hand-RLP + PyCryptodome keccak + double-sha via hashlib).
2. Pin `nonce: <N>` in `genesisHeader()` — the ONLY production-code functional change. Update the stale `GENESIS_DIFFICULTY` comment in `src/config/params.ts` in the same commit (it currently still says "difficulty 1 means every digest passes", which is FALSE under POW_LIMIT — documentation drift only, no behavior change). Same for the `Miner` header comment (still says "keccak hashing below a target").
3. Update pins/tests:
   - `test/genesis.test.ts`: manifest hash literal (×2 sites) + new assertions: `verifyHeaderPoW(genesisHeader)` returns `ok: true`; nonce ≠ 0; determinism re-pinned to the new hash. Add a stale-check that the preimage digest stays `cec2e282…` (proving only the nonce moved).
   - `test/node.test.ts` / `test/integration-two-nodes.test.ts`: no hardcoded genesis literals (verified by grep) — no changes needed except any *new* "startup genesis PoW validation" test and the existing "mismatched genesis.json" flow, which keeps working unchanged.
   - `test/handshake.test.ts`: uses a synthetic `"0xaa…"` genesis — no changes.
4. Add startup validation: `verifyHeaderPoW` check at genesis construction with fail-fast error message.
5. Bump `DEV_PARAM_VERSION` (value decided at activation review; locked decision D-… pending) — same commit as 2-4 so all nodes upgrade atomically.
6. Documentation: `docs/testnet-two-nodes.md` contains the hash in 5 places (lines 41, 60, 69, 193, 194) and a "same genesis hash" verification step — all need the new value; `docs/architecture.md`/`docs/networking.md` describe the handshake generically (verify no stale literals); CLI banner output flows automatically; `UNRESOLVED_DECISIONS.md` D-4/D-8 (genesis/difficulty provenance) gets the resolution note.
7. Full verification after the commit: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run security:check`, plus the independent Python genesis reproduction re-run against the new nonce.

Dependency map: step 1 → (2, 4, 5, 6); pins (3) depend on the nonce; startup validation (4) depends on a genesis that CAN pass (see ordering warning below). **Ordering requirement:** steps 2-5 must ship together — landing startup validation while the old `nonce: 0n` genesis is still pinned would make every node fail to start (the old genesis provably fails `verifyHeaderPoW`).

---

## 5. Safe mining / activation procedure, rollback and data-directory precautions (task §9)

### Safe mining procedure (when separately authorized)

1. Freeze the exact preimage: record `hashHeaderWithoutNonce(emptyGenesisConfig(0))` hex (`cec2e282…`) and the full header fields; assert them before and after the search — if anything moved, the mining session is invalid.
2. Run consent-gated mining in the background with: explicit nonce start offset, exclusive ranges per thread (no overlap), and periodic JSON checkpoints (`lastNonce`, `hashesTried`, `rate`) to a scratch path (e.g. `/tmp/opencode/genesis_search/`), so a crash resumes instead of restarting from 0.
3. On candidate discovery: a candidate satisfying `powHash ≤ POW_LIMIT` at difficulty 1 — verify THREE ways before pinning: production `verifyHeaderPoW`; a recomputed `blockHash(header-with-nonce)` recorded as the new pinned hash; and the independent Python reproduction (hand-RLP keccak preimage already proven; append nonce BE → sha-256 double via `hashlib.sha256`).
4. Only then proceed to the activation commit (§4).

### Rollback precautions

- Rollback of the activation commit reverts nonce, validation, version bump, docs **together** (git revert of the single commit is the intended mechanism). Reverting only the nonce while keeping startup validation would brick startup (old genesis fails PoW) — the commit-coupling protects against partial rollback.
- Datadir rollback is one-way: old-chain datadirs cannot adopt the new chain (manifest guard) and new-chain datadirs cannot run the old code (same guard in reverse — old code expects old hash). Archive datadirs before upgrading any operator node.

### Data-directory precautions

- `genesis.json` is written by `ensureFile` only on first start (fresh chain). It is the migration tripwire: never restore a `genesis.json` by hand; let the manifest guard fail loudly instead.
- `blocks.jsonl` is append-only and ledger-safe across restarts of the SAME chain; segments from a previous genesis are not reusable on the new chain (headers embed the old genesis lineage via `parentHash`).

---

## 6. Current risks / observations (no action taken this task)

| # | Observation | Disposition |
|---|---|---|
| 1 | `params.ts:38-42` comment is stale ("every digest passes" — false under POW_LIMIT since the redesign) | Fix in the activation commit (comment-only) |
| 2 | `miner.ts` header comment says "keccak hashing below a target" and "dev defaults make mining cheap" — stale | Fix in the activation commit (comment-only) |
| 3 | `params.ts:118` labels `DEV_MINING_HASH_RATE` a "sha256d/sec budget" while the per-candidate cost is keccak + sha256 + sha256 | Cosmetic; the activation mining run MUST measure real `powHash` rate (as done here: 24.4 kH/s single-thread), not the configured budget |
| 4 | `cli/index.ts` prints `keccak/s` for mining rate | Cosmetic wording, non-consensus |
| 5 | Startup genesis PoW validation does not exist yet (opened above) | The pending activation work item |
| 6 | Reported rate (24.4 kH/s) modestly exceeds previous session's 23.7 kH/s | Use current number for scheduling: ≈ 48.9 h mean single-thread; two threads should halve it |

---

## 7. Files changed

**None in the repository.** This task was read-only inspection/verification plus this report:

- Created: `REPORT_GENESIS_ACTIVATION_READINESS.md` (this file; untracked, not committed)
- Scratch (outside repo, ephemeral): `/tmp/opencode/genesis_audit.mjs` (production throughput measurement + PoW status), Python one-liner (independent PyCryptodome genesis-hash reproduction)
- No production code modified, no commits, no pushes, no resets/stashes/cleans; all pre-existing working-tree state preserved (`M do.md`, `M test/pow.test.ts`, 5 deleted stale report files left untouched)

## 8. Explicit non-claims

- ❌ No new genesis was mined (no nonce found or fabricated; current genesis hash remains `0x88b258e9…`, nonce `0n`)
- ❌ No startup validation was implemented
- ❌ No assumption is presented as verified: the genesis preimage and hash above were reproduced without project code (hand-derived RLP + PyCryptodome), and the PoW status of the current genesis was measured with the production validator itself
