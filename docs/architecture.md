# Architecture — CashBI

> **Dev milestone.** This document describes the current development build of
> CashBI. It intentionally omits production-grade choices (state trie, storage
> engine, formal security model) tracked in `UNRESOLVED_DECISIONS.md` (D-1..D-21).

## 1. Overview

CashBI is an independent Layer 1 Proof-of-Work blockchain in TypeScript/Node.js
with native coin **BIC**, EVM-compatible execution (miniEVM subset), and a
decentralized P2P network. The codebase lives directly under `/workspaces/codespaces-blank/src/`.

Notable dev-level design choices (each labeled with an open decision):

- **State root** = `keccak256` of JSON serialization of world state (not a Merkle trie). [D-14]
- **Hashing** = `keccak256` for PoW and address derivation; `sha256` for ledger checksums.
- **Difficulty** bounded linear retarget every 60 blocks. [D-5..D-8]
- **Fork choice** = highest cumulative difficulty; ties resolved by deeper block.
- **Block hash** = `keccak256(keccak256(RLP(header-without-nonce)) || 8-byte-BE-nonce)`.
- **Supply cap** enforced at validation: block reward + existing supply must not exceed `MAX_TOTAL_SUPPLY`. [D-1]

## 2. Module layout

```
src/
  chain/       block.ts, blockchain.ts, genesis.ts, persist.ts
  config/      params.ts            (ALL dev defaults, decision-labeled)
  consensus/   pow.ts               (PoW hash, target, retarget)
  crypto/      hash.ts, keys.ts     (keccak/sha256, secp256k1 keys + addresses)
  mining/      candidate.ts, miner.ts (block templates + consent-gated miner)
  net/         server.ts, discovery.ts (P2P transport + multi-mechanism discovery)
  node/        node.ts              (FullNode orchestration)
  rlp/         rlp.ts               (RLP codec)
  rpc/         rpc.ts               (JSON-RPC 2.0 server)
  state/       world.ts             (world state + undo-log Journal)
  tx/          transaction.ts, execute.ts, mempool.ts (txs, EVM executor, mempool)
  util/        bytes.ts, async.ts, peer.ts (encoding/helpers/peer parser)
  vm/          evm.ts               (miniEVM interpreter)
```

## 3. Data model

### Block
| Field | Type | Notes |
|---|---|---|
| parentHash | hex | parent header hash; genesis parent = 32 zero bytes |
| number | u64 | block height |
| timestamp | u64 | Unix seconds |
| difficulty | bigint | block difficulty |
| coinbase | hex (20B) | reward recipient |
| extraData | bytes | free-form bytes |
| gasLimit | bigint | dev constant MAX_BLOCK_GAS |
| gasUsed | bigint | cumulative tx gas |
| transactionsRoot | hex | keccak(RLP(txHashes)) — dev simplification [D-14] |
| stateRoot | hex | post-execution state root — dev JSON-root [D-14] |
| nonce | bigint (8-byte) | PoW nonce |

### Transaction (EIP-155-style)
RLP signed encoding: `[nonce, to, value, data, gasPrice, gas, r, s, chainId, v]`,
`v = rec + 35 + 2*chainId`. Hash = `keccak256(RLP([nonce,to,value,data,gasPrice,gas,chainId,0,0]))` (body-only).

## 4. Consensus & PoW

`powHash(header, nonce) = keccak256( keccak256(RLP(header-without-nonce)) || 8-byte-BE(nonce) )`.
A block is valid iff `powHash <= target` where `target = 2^256 / difficulty`.

Difficulty retargets every `DIFFICULTY_RETARGET_INTERVAL` blocks via bounded linear
correction clamped ×1/4..×4 per retarget, difficulty ∈ [1, 2^32−1].

## 5. Fork choice & reorg

All accepted blocks are indexed in memory by header hash, each retaining its
post-execution WorldState so forks can be compared by cumulative difficulty without
replaying from genesis. Best chain = entry with highest cumulative difficulty
(score); tie → deeper block. Losing-fork states retained up to `FORK_RETENTION = 512`
blocks for cheap re-switching. Missing-parent blocks queue (bounded) and retry on
every accepted block, so out-of-order sync converges.

## 6. Validation

Every accepted block is checked:
- header fields well-formed; coinbase valid
- `transactionsRoot` matches canonical serialization
- `gasUsed` matches executed receipts
- txs signed correctly (EIP-155), nonces sequential from tip state
- balances sufficient (value + gas reserved once; single deduction)
- block reward added; supply cap enforced
- `stateRoot` matches post-execution root
- PoW meets target
- not a duplicate

Any failure rejects with a reason. On acceptance, the block is appended to the
JSONL ledger (if persistence enabled) and included txs are removed from the mempool.

## 7. World state & Journal

Accounts: `{balance, nonce, code, storage}`. Mutations run inside an undo-log
Journal so any change can be rolled back to a checkpoint:
- failed tx → full gasLimit charged (dev rule), nonce still bumps
- succeeded tx → refund unused gas; used gas paid to coinbase

## 8. P2P & discovery

See `docs/networking.md`. Summary: TCP newline-delimited JSON frames with an
authenticated HELLO handshake (chainId + genesisHash + protocol version).
Peers come only from DNS seeds, HTTPS discovery feeds, local peer cache, gossip,
or operator-supplied manual addresses — **no hardcoded peer IPs**.

## 9. Storage

Dev: in-memory indexes + append-only JSONL ledger (`blocks.jsonl`) per data
directory, plus a `genesis.json` manifest guard refusing mismatched chains.
Production storage engine (LMDB/RocksDB) is open [D-18].

## 10. JSON-RPC 2.0

HTTP endpoints: `eth_chainId`, `bic_getBalance`, `bic_sendRawTransaction`,
`bic_getBlockByNumber`, `bic_getBlockByHash`, `bic_mineStatus`, `net_peerCount`.

## 11. Trust assumptions (dev only)

- No hard consensus finality; deep reorgs possible.
- No slashing, no staking, no validator set.
- Keyfiles stored unencrypted in the data dir [D-21].
