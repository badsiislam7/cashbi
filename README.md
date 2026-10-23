# CashBI (development build)

CashBI is an independent Layer 1 blockchain with its own native coin
**BIC**, Evidence-of-Work consensus, and an EVM-compatible execution
environment. It is a real (working) blockchain implementation in
TypeScript/Node.js — not a token on another chain, not a mock.

**⚠ DEVELOPMENT STATUS — NOT PRODUCTION-READY.**
Every permanent consensus parameter (max supply, issuance, block time,
chain id, genesis, …) is an open decision; all numbers in
`src/config/params.ts` are clearly labeled dev defaults, versioned via
`DEV_PARAM_VERSION` and tracked in [UNRESOLVED_DECISIONS.md](UNRESOLVED_DECISIONS.md).
No audit has been performed. Do not run this on any network that carries value.

## What is implemented

| Area | Status |
|---|---|
| Crypto keys (secp256k1), keccak-256, EVM-style addresses | ✅ |
| RLP encoding (spec vector-tested) | ✅ |
| EIP-155-style signed transactions, full validation | ✅ |
| Transaction mempool (fee-sorted, nonce/balance-aware, bounded) | ✅ |
| miniEVM interpreter (arithmetic/compare/memory/storage/jumps, RETURN/REVERT) | ✅ dev subset (D-15) |
| World state with undo-log (Journal) revert semantics | ✅ |
| PoW consensus: real keccak PoW, bounded difficulty retarget | ✅ dev params (D-5..D-8) |
| Blocks, headers, canonical hash, fork choice by cumulative difficulty | ✅ |
| Fork/reorg handling, out-of-order block queue, fork retention | ✅ |
| Decentralized P2P: TCP + newline-JSON frames, authenticated HELLO | ✅ |
| Discovery: DNS seeds, HTTPS feeds, peer cache, gossip, manual — **no hardcoded peers** | ✅ |
| Miner: real CPU PoW, **explicit consent gate**, configurable hash-rate throttle | ✅ |
| JSON-RPC server (`eth_chainId`, `bic_*`) | ✅ |
| CLI (`cashbi keygen`, `cashbi start`) | ✅ |
| Append-only JSONL ledger persistence + genesis manifest guard | ✅ dev storage (D-18) |

## Getting started

```bash
npm install          # dependencies
npm test             # full test suite (node:test)
npm run smoke        # end-to-end dev smoke script
npm run security:check   # npm audit + eslint + typecheck
```

### Key generation

```bash
npm run keygen -- --data ./data/node1
```

Writes an **unencrypted** dev `wallet.json` (0o600) with the private key and
the BIC address. Production key encryption is an open item (D-21).

### Running a node

```bash
npm run start -- --data ./data/node1 --allow-mining
```

- Mining **requires explicit consent**: either `--allow-mining`, or an
  interactive `YES` prompt (TTY). This is deliberate (see D-19) — a node
  never mines silently.
- Resource limit is configurable: `--mining-rate <hashes per second>`
  (default 512 H/s, throttled between hash batches).
- Peers come exclusively from DNS seeds / HTTPS discovery / the local peer
  cache / peer gossip / explicit `--peers` and `--dns-seed` / `--discovery-url`
  flags. **No peer IP addresses are hardcoded in the repository**
  (`test/security.test.ts` enforces this).

### Joining two nodes (devnet)

Node A (listener + miner):

```bash
npm run start -- --data ./data/a --port 30303 --allow-mining
```

Node B (connects to A by *operator-supplied* address — passed at runtime,
never hardcoded):

```bash
npm run start -- --data ./data/b --port 30305 --peers 127.0.0.1:30303
```

The nodes validate chain identity (chainId + genesis hash) during the HELLO
handshake and refuse incompatible peers.

## JSON-RPC

| Method | Description |
|---|---|
| `eth_chainId` | chain id (dev default 901291) |
| `bic_getBalance` `[address, "tip"]` | balance at tip |
| `bic_sendRawTransaction` `[rawHex]` | submit signed tx |
| `bic_getBlockByNumber` `[number]` | block by height |
| `bic_getBlockByHash` `[hash]` | block by hash |
| `bic_mineStatus` | miner status (consent, hashing, tip) |
| `net_peerCount` | connected peers |

## Layout

```
src/
  chain/     blocks, blockchain (validation/fork-choice), persistence
  config/    ALL dev-default parameters (decision-labeled)
  consensus/ PoW + difficulty retarget
  crypto/    keccak/sha256, secp256k1 keys
  mining/    block templates (tip + fork mining) and the consent-gated miner
  net/       P2P transport + multi-mechanism discovery
  node/      FullNode wiring
  rlp/       RLP codec
  rpc/       JSON-RPC 2.0 server
  state/     world state + undo-log Journal
  tx/        transactions, mempool, executor
  util/      bytes/peer/api helpers
  vm/        miniEVM interpreter
test/        node:test suites (unit + integration + security)
scripts/     smoke.ts end-to-end dev script
docs/        architecture, networking, mining deep-dives
```

Documentation map:
- [docs/architecture.md](docs/architecture.md) — data flow, consensus, storage
- [docs/networking.md](docs/networking.md) — P2P protocol + discovery
- [docs/mining.md](docs/mining.md) — PoW mechanics, consent, throttling
- [UNRESOLVED_DECISIONS.md](UNRESOLVED_DECISIONS.md) — D-1..D-21 open decisions
- [SECURITY.md](SECURITY.md) — threat model and known dev limitations

## License

MIT.
