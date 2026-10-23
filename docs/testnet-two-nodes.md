# Two-Node Testnet Integration Test

This document describes how to run a real two-node CashBI integration test using
independent node processes with actual TCP P2P connectivity.

## Prerequisites

- CashBI project built: `npm run build`
- Two free TCP ports (default: 30303/8545 for node A, 30304/8546 for node B)
- `curl` or similar for JSON-RPC requests

## Procedure

### 1. Generate a wallet for node A (the miner)

```bash
node --import tsx src/cli/index.ts keygen --data /tmp/cashbi-test/nodeA
```

Output:
```
address: 0x4ffe246d31945d92779b7bb787c6b89df681b1ff
written to /tmp/cashbi-test/nodeA/wallet.json (owner-only permissions) — keep it safe
```

### 2. Start node A (mining node)

```bash
node --import tsx src/cli/index.ts start \
  --data /tmp/cashbi-test/nodeA \
  --port 30303 \
  --http-port 8545 \
  --listen 127.0.0.1 \
  --coinbase 0x4ffe246d31945d92779b7bb787c6b89df681b1ff \
  --allow-mining \
  --mining-rate 1024
```

Expected output:
```
cashbi node started: chainId=901291 genesis=0x88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b tip=1
  p2p: listening on 127.0.0.1:30303
  rpc: http://127.0.0.1:8545
  mining: consented CPU PoW at 1024 keccak/s
```

### 3. Start node B (syncing node, connects to A)

```bash
node --import tsx src/cli/index.ts start \
  --data /tmp/cashbi-test/nodeB \
  --port 30304 \
  --http-port 8546 \
  --listen 127.0.0.1 \
  --peers 127.0.0.1:30303
```

Expected output:
```
cashbi node started: chainId=901291 genesis=0x88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b tip=0
  p2p: listening on 127.0.0.1:30304
  rpc: http://127.0.0.1:8546
```

### 4. Verify same chain ID and genesis hash

Both nodes log the same values on startup:
- chainId: `901291`
- genesis: `0x88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b`

Or via RPC:
```bash
curl -s -X POST http://127.0.0.1:8545/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# → "0xdb89bb"
```

### 5. Verify P2P connection

```bash
curl -s -X POST http://127.0.0.1:8545/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"net_peerCount","params":[]}'
# → {"jsonrpc":"2.0","id":1,"result":1}
```

Both nodes should report `result: 1` (one peer each).

### 6. Wait for node B to sync

Node B starts at tip=0 and syncs from node A via P2P gossip. Wait until both nodes report the same block number:

```bash
curl -s -X POST http://127.0.0.1:8545/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_getBestBlockNumber","params":[]}'
curl -s -X POST http://127.0.0.1:8546/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_getBestBlockNumber","params":[]}'
```

Both should return the same number.

### 7. Submit a signed transaction to node A

Create and sign a transaction (example using node A's coinbase):

```bash
node --import tsx -e "
import { signTransaction, encodeSignedTransaction, txHash } from './src/tx/transaction.js';
import { toHex, fromHex } from './src/util/bytes.js';
const privKey = fromHex('0x...'); // node A's coinbase private key
const tx = signTransaction({
  nonce: 0n, to: '0xrecipient...', value: 100000000000000000n,
  data: new Uint8Array(0), gasPrice: 1n, gas: 21000n, chainId: 901291,
}, privKey);
console.log(toHex(encodeSignedTransaction(tx)));
console.log(txHash(tx));
"
```

Submit via RPC:
```bash
curl -s -X POST http://127.0.0.1:8545/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_sendRawTransaction","params":["0x..."]}'
# → {"jsonrpc":"2.0","id":1,"result":"0x<tx-hash>"}
```

### 8. Verify transaction propagated to node B

Check recipient balance on both nodes:

```bash
curl -s -X POST http://127.0.0.1:8545/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_getBalance","params":["0xrecipient..."]}'
curl -s -X POST http://127.0.0.1:8546/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_getBalance","params":["0xrecipient..."]}'
```

Both should return the same balance.

### 9. Verify block convergence

Both nodes should converge on the same best block:

```bash
curl -s -X POST http://127.0.0.1:8545/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_getBestBlockHash","params":[]}'
curl -s -X POST http://127.0.0.1:8546/ -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"bic_getBestBlockHash","params":[]}'
```

Both should return the same hash.

### 10. Restart node B and verify ledger recovery

```bash
# Stop node B (Ctrl+C or kill)
# Restart with the same data directory:
node --import tsx src/cli/index.ts start \
  --data /tmp/cashbi-test/nodeB \
  --port 30304 \
  --http-port 8546 \
  --listen 127.0.0.1 \
  --peers 127.0.0.1:30303
```

Expected: Node B recovers its tip from `blocks.jsonl` and reconnects to node A.

### 11. Test mismatched genesis rejection

Copy node A's data directory, modify `genesis.json` to a different hash, and try to start:

```bash
cp -r /tmp/cashbi-test/nodeA /tmp/cashbi-test/nodeC
# Edit /tmp/cashbi-test/nodeC/genesis.json to change genesisHash
node --import tsx src/cli/index.ts start --data /tmp/cashbi-test/nodeC --port 30305
```

Expected: Exit code 1 with error:
```
node init failed: stored genesis hash mismatch — refusing to continue on a different chain
```

## Ports used in this document

| Node | Data Dir | P2P Port | RPC Port |
|------|----------|----------|----------|
| A (miner) | /tmp/cashbi-test/nodeA | 30303 | 8545 |
| B (sync) | /tmp/cashbi-test/nodeB | 30304 | 8546 |

## Observed Results (from actual run)

| Step | Result |
|------|--------|
| Node A start | chainId=901291, genesis=0x88b258e9..., tip=1, mining enabled |
| Node B start | chainId=901291, genesis=0x88b258e9..., tip=0, peers=1 |
| P2P connection | peers=1 on both nodes |
| Tx submission | Accepted by node A, result=tx hash |
| Balance propagation | Recipient balance 0x016345785d8a0000 (0.1 BIC) on both nodes |
| Block convergence | Both nodes at tip=119, hash=0x2f75f8db11500b0afde0a01a41db1416ba7d3133e04646f8c21af982d96641f6 |
| Node B restart | Recovered tip=124 from ledger, synced to tip=185, peers=1 |
| Mismatched genesis | Exit code 1, "stored genesis hash mismatch" |
