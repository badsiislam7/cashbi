# CashBI — Generation Summary (Complete Workspace Record)

**Workspace:** `/workspaces/codespaces-blank`
**Project:** CashBI — independent Layer 1 Proof-of-Work cryptocurrency (native coin ticker BIC), EVM-compatible execution, decentralized P2P networking, TypeScript/Node.js.
**Status:** Development build (NOT production-ready); all work committed locally, nothing pushed/deployed.

---

## 1. Overview of what was generated

CashBI is a real blockchain implementation (not a token, dashboard, or mock) consisting of:

| Layer | Modules | Purpose |
|---|---|---|
| Crypto | `src/crypto/hash.ts`, `src/crypto/keys.ts` | keccak-256/sha256, secp256k1 keys, EVM-style addresses |
| Codec | `src/rlp/rlp.ts` | RLP encoding/decoding (spec vectors pass) |
| Transactions | `src/tx/transaction.ts` | EIP-155-style signing/decode/validate, `txHash` |
| Mempool | `src/tx/mempool.ts` | fee-sorted, nonce/balance-aware, bounded |
| Execution | `src/tx/execute.ts` | single-deduction value+gas model, EVM executor wrapper |
| EVM | `src/vm/evm.ts` | miniEVM interpreter (dev subset) |
| State | `src/state/world.ts` | world state + Journal undo-log revert |
| Consensus | `src/consensus/pow.ts` | PoW hash/target, bounded difficulty retarget |
| Blocks | `src/chain/block.ts` | header/body, canonical hash, `transactionsRoot`, encode/decode |
| Genesis | `src/chain/genesis.ts` | genesis block + state build |
| Blockchain | `src/chain/blockchain.ts` | validation, fork choice by cumulative difficulty, reorg, pending queue |
| Persistence | `src/chain/persist.ts` | append-only JSONL ledger |
| Mining | `src/mining/candidate.ts`, `src/mining/miner.ts` | block templates (tip + fork mining), consent-gated CPU miner |
| P2P | `src/net/server.ts` | TCP newline-JSON frames, authenticated HELLO, gossip |
| Discovery | `src/net/discovery.ts` | DNS seeds, HTTPS feeds, local cache, gossip, manual — no hardcoded IPs |
| Node | `src/node/node.ts` | FullNode orchestration |
| RPC | `src/rpc/rpc.ts` | JSON-RPC 2.0 server |
| CLI | `src/cli/index.ts` | `cashbi keygen`, `cashbi start` |

### Config
- `src/config/params.ts` — ALL dev-default parameters, each labeled with a decision ID (D-1…D-21). Versioned via `DEV_PARAM_VERSION`.

---

## 2. Files created (this session + cumulative)

### New documentation
- `README.md` — project overview, getting started, CLI/RPC, layout, doc map
- `UNRESOLVED_DECISIONS.md` — D-1…D-21 open decisions with dev-default context
- `docs/architecture.md` — data flow, consensus, storage, trust assumptions
- `docs/networking.md` — P2P protocol, wire messages, discovery mechanisms, peer management
- `docs/mining.md` — PoW algorithm, consent gate, resource limits, fork mining
- `SECURITY.md` — threat model, known dev limitations, hard guards
- `.gitignore` — node_modules, dist, data dirs, wallet.json, logs, `*.jsonl`

### Tooling config
- `eslint.config.js` — ESLint 9 flat config (`typescript-eslint` recommended + custom rules)

### Pre-existing user files preserved (not touched)
- `do.md`, `do1.md` (original instructions/workspace rules)
- `package.json`, `package-lock.json`, `tsconfig.json`

---

## 3. Files modified (fixes since last checkpoint)

### `src/tx/execute.ts`
- Changed `tx.gas <= baseGas` → `tx.gas < baseGas` so a plain transfer with exactly `gas = 21000` (Ethereum intrinsic gas) is valid. Previously a valid transfer was rejected with "gas must exceed the base transaction gas."

### `src/chain/persist.ts`
- `appendLedger`: async → synchronous (`openSync`/`writeSync`/`closeSync`) so ledger writes complete and are ordered before callers read them (fixes persistence roundtrip race).
- `writeLedger`: async → synchronous for the same ordering guarantee.
- Imports switched from `node:fs/promises` to `node:fs` sync equivalents.

### `src/chain/blockchain.ts`
- `appendLedger` call site: removed `void` (now synchronous).

### `src/mining/candidate.ts`
- Removed duplicated/leftover `import type { WorldState as RealWorldState }` line.

### `src/net/server.ts`
- Removed the second `socket.connect(port, host)` call in `connect()` that tore freshly opened outbound sockets down (peers connected then immediately disconnected).
- Removed the `sendHello` call with `bestNumber: -1` from both outbound and inbound paths; HELLO is now sent by the node via `sendHelloWithTip` with the authoritative tip.
- Removed unused `DEV_NETWORK_VERSION` import.
- Removed temporary `CASHBI_P2P_DEBUG` stack-trace instrumentation.

### `src/util/peer.ts`
- `validHost`: hosts beginning with a digit must be valid IPv4 literals — rejects look-alike traps such as `10-1.2.3.4` (passes `test/security.test.ts`).

### `src/consensus/pow.ts`
- Fixed inaccurate comments: nonce serialization is 8-byte **BE** (not LE); retarget clamp is ×1/4…×4 per retarget (docstring said ×1/2…×2, matching the code).

### `src/cli/index.ts`
- Removed unused imports (`parseArgs`, `addressFromPrivateKey`, `privateKeyHex`, `fromHex`).
- Removed unused `config = defaultNodeConfig(dataDir)` assignment (the config object is built inline in the return).

### `src/crypto/keys.ts`
- Removed unused `randomBytes32` import.

### `src/net/server.ts` / `src/vm/evm.ts` / `src/state/world.ts` / `src/tx/transaction.ts`
- Removed unused imports (`DEV_NETWORK_VERSION`, `toHex`, `padLeft`, `ECDSASignature`, `bigToHexBE`).

### `scripts/smoke.ts`
- Removed unused `minedBlock`/`minedNonce` vars and unused imports (`recoverAddress`, `blockHash`, `encodeBlock`, `decodeBlock`, `minerPriv`).

### Test files
- `test/chain.test.ts` — removed unused imports (`encodeBlock`, `Block`, `WorldState`) and deleted leftover dead helpers `tile()` and `b1TemplateOnly()`.
- `test/crypto.test.ts` — removed unused `keccak256` import.
- `test/evm.test.ts` — removed unused `OpCode`, `fromHex` imports.
- `test/pow.test.ts` — removed unused `GENESIS_DIFFICULTY`, `hashHeaderWithoutNonce`, `bigToHexBE` imports.
- `test/transaction.test.ts` — removed unused `from` binding.
- `test/node.test.ts` — both nodes now share one `GenesisConfig` (they were on different networks; added `emptyGenesisConfig` import).

---

## 4. Verification results

| Check | Result |
|---|---|
| `npm test` (35 tests) | **35 pass, 0 fail** |
| `npx tsc -p tsconfig.json --noEmit` | clean (0 errors) |
| `npm run security:check` | clean (`npm audit`: 0 vulnerabilities; eslint: 0 errors; typecheck: clean) |
| `scripts/smoke.ts` | end-to-end pass (crypto → tx → mempool → mine → block accept → balances correct) |

Notable passing tests:
- `chain: ledger persistence roundtrip`
- `chain: mempool drops included transactions after block acceptance`
- `chain: fork & reorg — deeper fork replaces the tip`
- `two full nodes sync and gossip blocks + transactions`
- `security: no hardcoded non-loopback IPv4 addresses in src`
- `security: peer address parser defensively rejects bad input`

---

## 5. Git

- `git init` run in `/workspaces/codespaces-blank`
- Initial commit `7d5df5a` on branch `main`
- Working tree clean
- **No remote configured, nothing pushed** (per user instruction)

Commit message summary: "CashBI initial commit: Layer 1 PoW blockchain (BIC)" — covers all source, tests, docs, config, tooling, and the preserved user files `do.md`/`do1.md`.

---

## 6. Design decisions recorded

All permanent consensus parameters are explicitly **unresolved**; `src/config/params.ts` holds dev defaults only, labeled D-1…D-21 and tracked in `UNRESOLVED_DECISIONS.md`. Key dev defaults:

- Max supply: 100,000,000 BIC (D-1 open)
- Decimals: 18 (D-2 open)
- Chain id: 901291 (D-3 open)
- Block reward: 2 BIC (D-1/D-8 open)
- Difficulty: 1, retarget every 60 blocks, clamp ×1/4…×4 (D-5…D-8 open)
- Target block time: 1s (D-7 open)
- State root: keccak of JSON serialization, NOT an MPT (D-14 open)
- EVM: miniEVM subset (D-15 open)
- Storage: JSONL ledger (D-18 open)
- Mining: explicit consent gate + keccak/sec throttle (D-19 open)
- No hardcoded peer IPs anywhere in `src/` (enforced by `test/security.test.ts`)

---

## 7. Directory tree (project files only)

```
/workspaces/codespaces-blank/
├── do.md
├── do1.md
├── README.md
├── UNRESOLVED_DECISIONS.md
├── SECURITY.md
├── .gitignore
├── eslint.config.js
├── package.json
├── package-lock.json
├── tsconfig.json
├── scripts/
│   └── smoke.ts
├── src/
│   ├── chain/       block.ts, blockchain.ts, genesis.ts, persist.ts
│   ├── cli/         index.ts
│   ├── config/      params.ts
│   ├── consensus/   pow.ts
│   ├── crypto/      hash.ts, keys.ts
│   ├── mining/      candidate.ts, miner.ts
│   ├── net/         server.ts, discovery.ts
│   ├── node/        node.ts
│   ├── rlp/         rlp.ts
│   ├── rpc/         rpc.ts
│   ├── state/       world.ts
│   ├── tx/          transaction.ts, execute.ts, mempool.ts
│   ├── util/        async.ts, bytes.ts, peer.ts
│   └── vm/          evm.ts
├── test/
│   ├── chain.test.ts
│   ├── crypto.test.ts
│   ├── evm.test.ts
│   ├── helpers.ts
│   ├── node.test.ts
│   ├── pow.test.ts
│   ├── rlp.test.ts
│   ├── security.test.ts
│   └── transaction.test.ts
└── docs/
    ├── architecture.md
    ├── mining.md
    └── networking.md
```

---

## 8. What was NOT done (per instructions)

- No `git push` / no remote configured.
- No deploy or publish.
- No permanent consensus parameters invented.
- Nothing outside `/workspaces/codespaces-blank` was created or modified.
- No existing user files (`do.md`, `do1.md`) were deleted or overwritten.
