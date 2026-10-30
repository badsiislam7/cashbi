# CashBI — Final Pre-Mining Reliability Audit

Repository: `/workspaces/codespaces-blank`
Task: `do.md` — "Final pre-mining readiness audit"
Date: 2026-10-30
HEAD: `b1be33c793357e364edcc2ec49009cb6220b3d6c` (== origin/main)

This is a **read-only audit**. No source files, tests, documentation, configuration,
consensus parameters, or Git history were modified. No real mining was started.
All working-tree state is preserved.

---

## 1. Files and Code Paths Inspected

| File | Role |
|---|---|
| `src/chain/genesis.ts` | Genesis construction: `buildGenesis`, `genesisHeader`, `genesisBlockHash`, `genesisManifest`, `emptyGenesisConfig` |
| `src/chain/block.ts` | `blockHash`, `hashHeaderWithoutNonce`, `encodeHeaderView`, `decodeBlock`, `encodeBlock`, `headerWithoutNonce` |
| `src/consensus/pow.ts` | `verifyHeaderPoW`, `isMiningCandidate`, `powHash`, `difficultyToTarget`, `meetsTarget`, `retargetDifficulty`, `nextDifficulty` |
| `src/config/params.ts` | `POW_LIMIT`, `GENESIS_DIFFICULTY`, `DEV_CHAIN_ID`, `DEV_PARAM_VERSION`, `DIFFICULTY_RETARGET_INTERVAL`, `TARGET_BLOCK_TIME_SECONDS`, `BLOCK_REWARD`, `MAX_TOTAL_SUPPLY`, `MAX_BLOCK_GAS`, etc. |
| `src/tools/genesis-mining.ts` | Mining tool: `buildFreshCheckpoint`, `validateCheckpoint`, `verifyGenesisCandidate`, `reverifyRecordedCandidateIfAny`, `reconcileOrphanResultArtifact`, `runMiningSession`, `parseCliArguments` |
| `scripts/mine-genesis.ts` | CLI wrapper: argument parsing, per-worker budget distribution, checkpoint load/save, `runMiningSession` invocation |
| `src/chain/blockchain.ts` | `Blockchain` class: genesis construction, `blockHash` usage, `nextDifficulty` via `nextDifficulty` callback, `tryImport` → `checkPoW` → `verifyHeaderPoW`, `acceptBlock` |
| `src/node/node.ts` | Node startup: `genesisFromConfig`, `loadChain`, genesis hash stored in `data/genesis.json`, mismatch abort, miner startup gated on `--mine` + coinbase |
| `src/net/server.ts` | P2P handshake: `chainId` and `genesisHash` in handshake message; mismatch → peer rejection |
| `src/mining/miner.ts` | Miner class: `verifyHeaderPoW` per nonce, `isMiningCandidate`, `startMining` gated on consent, `stop` |
| `src/mining/candidate.ts` | `buildBlockForMining`: builds candidate header from chain tip + transactions |
| `test/pow.test.ts` | PoW unit tests: difficulty-to-target, powHash vector, verifyHeaderPoW, candidate acceptance/rejection, lane/retarget logic |
| `test/genesis-mining-tool.test.ts` | Mining tool tests: checkpoint validation, lane disjointness, resume continuity, candidate artifact integrity |
| `.work/genesis-long-benchmark/cp.json` | Actual checkpoint from 5,000,000-attempt bounded benchmark |
| `.work/genesis-long-benchmark/bench-output.txt` | Full benchmark stdout |

---

## 2. Inspection Findings

### 2.1 Genesis Construction (`src/chain/genesis.ts`)

`buildGenesis(config)` constructs the genesis block via `genesisHeader(config)`:
- `parentHash = "0x" + "00".repeat(32)` (all zeros)
- `number = 0`
- `timestamp` = config timestamp (default 0)
- `difficulty = BigInt(GENESIS_DIFFICULTY)` = `1n`
- `coinbase = "0x" + "00".repeat(20)`
- `extraData = config.extraData` (default `"cashbi-dev-genesis"`)
- `gasLimit = MAX_BLOCK_GAS`
- `gasUsed = 0n`
- `transactionsRoot = transactionsRoot([])` = keccak256(RLP([]))
- `stateRoot = "0x" + "00".repeat(32)` (then overwritten by state root)
- `nonce = 0n`

The genesis header is fully deterministic given the config. The nonce field is `0n` and is **not** part of the preimage digest (`hashHeaderWithoutNonce` omits `nonce`).

### 2.2 Production PoW Verification (`src/consensus/pow.ts`)

The mining tool reuses production functions exclusively:
- `isMiningCandidate(header, nonce)` → `meetsTarget(powHash(header, nonce), header.difficulty)`
- `verifyHeaderPoW(header, { nonce })` → `powHash(header, nonce)` then `meetsTarget`
- `difficultyToTarget(difficulty)` = `POW_LIMIT / difficulty`

These are the **same functions** used by `Blockchain.acceptBlock()` via `checkPoW`. There is no separate or weakened mining path.

`verifyGenesisCandidate` in `src/tools/genesis-mining.ts:558` re-runs `verifyHeaderPoW`, re-derives `blockHash`, cross-checks `preimageDigest`, and recomputes `powHash`. Only after all checks pass is a `CandidateRecord` built.

### 2.3 Genesis Nonce / Pinning

The genesis nonce is pinned at `0n` in `src/chain/genesis.ts:52`:
```typescript
nonce: 0n,
```

The genesis import path (`buildGenesis` → `genesisHeader`) **bypasses** `verifyHeaderPoW` entirely — the genesis block is accepted as-is without PoW verification. This means the pinned nonce `0n` **fails** `verifyHeaderPoW` at difficulty 1 (verified in `test/pow.test.ts:391-406` where nonce `0` is explicitly tested as a failure).

**Consequence:** Startup genesis PoW validation **must not** be activated before a valid nonce is found. Every fresh node would reject its own hardcoded genesis and refuse to start. The nonce `0n` must remain pinned until a valid nonce is found and pinned via `genesisManifest`.

### 2.4 `paramVersion` and Handshake Compatibility

`DEV_PARAM_VERSION = "0.0.1-dev"` (src/config/params.ts:20).

The genesis `GenesisManifest` includes `paramVersion` (src/chain/genesis.ts:82-89). The P2P handshake (`src/net/server.ts`) includes `paramVersion` in the handshake message and peers with mismatched `chainId`/`genesisHash` are rejected (`src/net/server.ts:196`).

**No change to `DEV_PARAM_VERSION`** should be made as part of genesis re-mining. It remains `"0.0.1-dev"`. A parameter-version change is a separate future activation decision.

### 2.5 Fresh-Data-Directory Requirement

The genesis hash is derived from the genesis header (including the re-mined nonce). A re-mined genesis produces a **different genesis hash**, i.e., a new chain root.

Existing `data/` directories (blockstore, state, peer logs) belong to the **old chain** and **must not be mixed** with the new one. The node startup code (`src/node/node.ts:122-134`) already detects genesis hash mismatch and refuses to start:
```
checkpoint chainId/stored genesis hash mismatch → fail
```

Operators must move old `data/` directories aside before first startup with the new genesis:
```
mv data archive/pre-remine-<date>
```

### 2.6 Checkpoint Integrity and Resume

The mining tool (`src/tools/genesis-mining.ts`) implements:
- **Atomic checkpoint writes**: temp file + `renameSync` (atomic on POSIX), temp cleanup on failure
- **Full checkpoint validation** (`validateCheckpoint`): schema/version, genesis identity (preimage digest, chainId, difficulty, powLimit, block time, retarget interval, paramVersion), plan block, worker state (lane membership, overlap guards), attempt-count sum, candidate structure
- **Refuse silent reset**: malformed JSON or invalid checkpoint → abort, file untouched, operator must consciously move/delete
- **Exact resume**: each worker resumes at its exact saved `nextNonce`; no completed attempt reprocessed; no other worker's lane touched

The latest 5,000,000-attempt checkpoint (`/workspaces/codespaces-blank/.work/genesis-long-benchmark/cp.json`) confirms:
- `totalAttempts: 5000000` = sum of worker attempts (2,500,000 + 2,500,000)
- Worker 0 `nextNonce: "0x4c4b40"` = 5,000,000 = `workerChunkStart(0, 1)` ✓
- Worker 1 `nextNonce` = `0x7270e0` = 7,500,000 = `workerChunkStart(1, 1)` ✓
- Lanes disjoint: worker 0 [0, 2500000), worker 1 [2500000, 5000000) — covers [0, 5000000) exactly
- `candidate: null` (no valid nonce found)

---

## 3. Requirements Audit

### Requirement 1: Inspect genesis construction and mining pipeline
**Status: COMPLETE**

Genesis construction (`src/chain/genesis.ts:39-54`) builds the header with nonce `0n`, excludes nonce from preimage (`hashHeaderWithoutNonce`), and derives genesis hash via `blockHash` (keccak256 of RLP(headerWithoutNonce) || 8-byte BE nonce).

The mining tool (`src/tools/genesis-mining.ts`) loads the genesis plan via `getGenesisPlan()`, partitions nonce space into worker lanes, hashes each nonce via `isMiningCandidate` (production `verifyHeaderPoW` path), and re-verifies candidates via `verifyGenesisCandidate` (production `verifyHeaderPoW` + `blockHash` + preimage cross-check).

### Requirement 2: Identify every location containing genesis nonce fields

Genesis nonce locations:
1. `src/chain/genesis.ts:52` — `nonce: 0n` in `genesisHeader()` (the pinned genesis nonce)
2. `src/chain/block.ts:31` — `nonce: bigint` field in `BlockHeader` interface
3. `src/chain/block.ts:68` — `blockHash` includes `nonce & 0xffffffffffffffffn` as 8-byte BE
4. `src/consensus/pow.ts:92` — `powHash` includes `nonce & 0xffffffffffffffffn` as 8-byte BE
5. `src/tools/genesis-mining.ts:564` — `verifyGenesisCandidate` sets `header.nonce = nonce & MAX_UINT64` then calls `verifyHeaderPoW`/`powHash`/`blockHash`
6. `scripts/mine-genesis.ts` — no nonce pinning; reads nonce from checkpoint/result artifact

No nonce is **pinned** (hardcoded as a valid value) anywhere except the genesis header's `nonce: 0n`, which is the **starting point** for mining, not a verified valid nonce.

### 2.7 Production PoW Verification is Authoritative

`verifyGenesisCandidate` (`src/tools/genesis-mining.ts:558-603`):
1. Sets `header.nonce = nonce & MAX_UINT64`
2. Calls `verifyHeaderPoW(header, { nonce })` — production validator
3. Cross-checks `hashHeaderWithoutNonce(header)` against `plan.preimageDigest`
4. Computes `powHash(header, header.nonce)` and `blockHash(header)` — production functions
5. Only builds a `CandidateRecord` if **all** checks pass

The checkpoint candidate field and result artifact are only written after **all** checks pass. `reverifyRecordedCandidateIfAny` (src/tools/genesis-mining.ts:1164-1179) re-verifies any recorded candidate on resume and hard-fails on mismatch.

---

## 4. Stopping and Resuming

The mining tool supports resumable sessions:

- **Checkpoint**: versioned (`cashbi-genesis-mining-checkpoint` v1), atomic (temp file + atomic rename), full validation on load (schema, version, genesis identity, consensus constants, plan, worker lanes, attempt-count sum, candidate structure), refuses silent reset on malformed/invalid file
- **Resume**: each worker continues at its exact saved `nextNonce`; no completed attempt reprocessed; no other worker's lane touched
- **SIGINT**: handler sends `stop` to all workers, workers finish current batch, checkpoint persists, process exits
- **Multiple invocations**: each invocation has its own `--max-attempts` budget; `totalAttempts` in checkpoint accumulates cumulatively

Verified by tests in `test/genesis-mining-tool.test.ts`:
- "resume is exact — zero reprocessing across invocations"
- "bounded session stops at the budget with exact per-worker counts"
- "lane exhaustion near MAX_UINT64 marks workers done"

---

## 6. Timing Analysis (from 5,000,000-attempt benchmark)

### 7.1 Measurements

| Measurement | Value | Source |
|---|---|---|
| Shell wall-clock | 238.911 s | `time npm run mine-genesis ...` |
| Tool-reported elapsed | 234.4 s | `Date.now()` inside `runMiningSession`, before worker fork to after final checkpoint persist |
| Attempts | 5,000,000 | Checkpoint `totalAttempts` |
| Shell-time throughput | 20,923 H/s | 5,000,000 / 238.911 |
| Tool-reported throughput | 21,333 H/s | 5,000,000 / 234.4 |

### 7.2 What Each Timer Covers

| Component | Included in shell time | Included in tool time |
|---|---|---|
| Node.js + tsx startup | Yes | No |
| Module imports (consensus, block, genesis, util) | Yes | No |
| `buildGenesis()` | Yes | No |
| `buildFreshCheckpoint()` + first checkpoint write | Yes | No |
| Worker `fork()` + worker startup | Yes | No |
| Per-nonce hashing | Yes | Yes |
| IPC (progress messages) | Yes | Yes |
| Final `persist(false)` (checkpoint write) | Yes | Yes |
| `process.exit(0)` | Yes | No |

The ~4.5 second gap (238.911 - 234.4) is dominated by Node.js startup, tsx transpilation, and module imports — one-time costs that become negligible over multi-day runs.

### 7.3 Throughput

| Basis | Rate (H/s) |
|---|---|
| Shell-time (full process) | 5,000,000 / 238.911 = **20,923** |
| Tool-reported (session only) | 5,000,000 / 234.4 = **21,333** |
| Tool-reported final progress line | 21,333 |

The ~2% difference between shell-time and tool-reported throughput is entirely attributable to startup overhead (~4.5s out of 238.9s, ~1.9%).

### 7.4 Expected Search Duration

Expected hashes per valid nonce at difficulty 1: **4,295,032,833 (~2³²)**.

| Throughput basis | Rate (H/s) | Expected time (seconds) | Expected time (hours) |
|---|---|---|---|
| Shell-time (full process, conservative) | 20,924 | 201,375 | **55.94** |
| Tool-reported (session only) | 21,333 | 201,131 | 55.87 |

**Recommended planning figure: ~56 hours** (using the conservative shell-time throughput).

**This is an ESTIMATE, not a guarantee.** PoW search follows a geometric distribution with high variance:
- 63% chance of finding a valid nonce within 4.295 billion hashes
- 37% chance of needing *more* than 4.295 billion hashes
- Non-trivial probability of needing 2×, 5×, or 10× the expected hashes

---

## 8. Files Requiring Changes Before Real Mining

None of these changes should be made in this task. They are listed for completeness:

| File | Change | Why |
|---|---|---|
| `src/chain/genesis.ts` | Pin valid nonce in `genesisHeader()` | Only after a valid nonce is found and independently verified |
| `src/chain/genesis.ts` | Update `DEV_PARAM_VERSION` | Separate activation decision; not part of mining |
| `src/node/node.ts` | Enable startup genesis PoW validation | Only after valid nonce pinned; otherwise fresh nodes reject genesis |
| `src/node/node.ts` | genesis hash check in `loadChain` | Already implemented; protects against mixed data |
| `src/net/server.ts` | genesis hash check in handshake | Already implemented; prevents mixed-chain peers |

---

## 9. Tests Needed Before Activation

| Test | Purpose | Status |
|---|---|---|
| End-to-end: mine a valid nonce at difficulty 1 | Prove the mining pipeline produces a valid block | Not yet done (requires ~4.3B hashes) |
| Independent re-verification of candidate | Non-TypeScript reproduction (Python/PyCryptodome) | Not yet done (no candidate yet) |
| Genesis import with valid nonce | Verify `buildGenesis` + `verifyHeaderPoW` accepts the mined genesis | Not yet done |
| Node startup with new genesis | Verify node starts with re-mined genesis hash | Not yet done |
| P2P handshake with new genesis hash | Verify peers reject mismatched genesis | Not yet done |

---

## 10. Final Verdict: **NOT READY FOR REAL MINING**

### Reasons:

1. **No valid genesis nonce exists.** The pinned nonce `0n` fails production `verifyHeaderPoW` at difficulty 1. A real search requires ~4.295 billion expected hashes (~56 hours at ~21,300 H/s with 2 workers) and is a separately authorized operation.

2. **No valid nonce has been found.** All bounded searches (100,000 and 5,000,000 attempts) returned `candidate: null`.

3. **No nonce has been pinned** in `src/chain/genesis.ts`. The genesis nonce remains `0n`, which fails production PoW verification.

4. **Startup genesis validation is correctly disabled.** Activating it before a valid nonce exists would cause every fresh node to reject its own genesis and refuse to start.

### What IS Ready:

- The mining tool is fully implemented, tested, and bounded (124+ tests pass, typecheck/lint/security clean)
- Checkpoint/resume is atomic, validated, and exact (no reprocessing, no gaps)
- Candidate verification uses production `verifyHeaderPoW` + `blockHash` exclusively
- The CLI safety gate (`--mine` + all required arguments) prevents accidental mining
- The checkpoint/resume mechanism supports multi-invocation bounded searches

### What Remains Before Real Mining:

1. **Run a real genesis nonce search** (separately authorized, ~56 hours mean at ~21,333 H/s with 2 workers)
2. **Independently verify the discovered candidate** (non-TypeScript reproduction, e.g., PyCryptodome)
3. **Pin the verified nonce** in `src/chain/genesis.ts`
4. **Enable startup genesis PoW validation** (only after nonce is pinned)
5. **Update `DEV_PARAM_VERSION`** (separate activation decision)

---

## 11. Confirmations

- **No real mining was started.** All invocations were bounded: 100,000 and 5,000,000 attempts.
- **No consensus parameters changed.** `POW_LIMIT`, `GENESIS_DIFFICULTY=1`, `DEV_CHAIN_ID=901291`, `DEV_PARAM_VERSION="0.0.1-dev"`, `MAX_TOTAL_SUPPLY=16,000,000 BIC` all untouched.
- **No valid nonce fabricated.** The checkpoint shows `candidate: null`.
- **No commits, pushes, or Git history operations.** All changes are uncommitted.
- **No source files modified.** `src/` is untouched; only the new report file `REPORT_GENESIS_MINER_FINAL_AUDIT.md` was created (and the pre-existing `.work/` benchmark directory from prior tasks).

**READINESS VERDICT: NOT READY** — no valid genesis nonce exists; a separately authorized real mining search is required before activation.