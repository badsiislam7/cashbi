# Networking — CashBI P2P protocol & discovery

## Transport

- TCP, newline-delimited JSON frames (`\n` terminated).
- Frame cap `P2P_FRAME_LIMIT_BYTES = 8 MiB`; oversized frames ban the peer.
- `P2P_PROTOCOL = "cashbi/0.1"`, `DEV_NETWORK_VERSION = 1` — mismatched peers
  are dropped during HELLO.
- Default ports: P2P `30303`, JSON-RPC `8545` (operator-configurable) [D-12].

## Handshake (HELLO)

Every connection opens with a HELLO message:

```
{type:"HELLO", protocol, networkVersion, chainId, genesisHash, bestNumber, bestHash}
```

A peer is accepted iff `chainId` and `genesisHash` match local config; otherwise
the connection is dropped immediately — incompatible chains never exchange
blocks or txs. After HELLO the peer's tip number is tracked; if the peer's
`bestNumber` exceeds our tip we request blocks from `tip+1`.

## Wire messages

| Direction | Message | Payload |
|---|---|---|
| both | HELLO | chainId, genesisHash, protocol, tip |
| both | NEW_BLOCK | `{block: hex}` — gossip + forward (excl. originator) |
| both | NEW_TX | `{tx: hex}` — full signed tx, gossip + forward |
| both | GET_BLOCKS | `{startNumber, maxCount}` → BLOCKS |
| both | BLOCKS | `{blocks: [hex], tipNumber, tipHash}` |
| both | GET_PEERS / PEERS | peer list gossip (feeds discovery) |
| both | PING / PONG | keepalive |

Outbound `connect()` calls `tcpConnect` once (a prior double-`connect()` bug that
tore sockets down is fixed). Inbound connections register and HELLO is sent by
the node via `sendHelloWithTip` (authoritative tip, not `-1`).

## Discovery mechanisms (all runtime-supplied, NO hardcoded IPs)

1. **DNS seeds** — operator-configured hostnames resolved at runtime via
   `dns.lookup(..., {all: true})` → `host:defaultPort`. Default list is empty
   pending community decision [D-20].
2. **HTTPS discovery feeds** — operator-configured endpoints returning JSON
   `{peers: ["host:port", ...]}`. Default list empty [D-20].
3. **Local peer cache** — `peers.json` in the data directory, loaded at start
   and periodically saved [D-13].
4. **Peer gossip** — `GET_PEERS`/`PEERS` exchange shares known addresses.
5. **Manual** — `--peers host:port` at CLI startup.

Parser `parsePeerAddress` accepts `host:port`, IPv4 literals, `[v6]:port`; hosts
that begin with a digit must be valid IPv4 literals (rejects look-alike traps
like `10-1.2.3.4`). Port must be 1..65535.

## Peer management

- `MAX_PEERS = 32` connected, `MAX_PENDING_PEERS = 96` pending.
- Keepalive every 30s (PING); peers silent > 60s are dropped.
- Misbehaving peers (bad frames, incompatible chain, oversized frame) are
  banned/dropped.

## Security notes

- Peer IP addresses only arrive at runtime from operator/discovery; none are
  in source (`test/security.test.ts` asserts this).
- All discovery is non-blocking: DNS/HTTPS cycles run in the background and
  never delay startup.
- No TLS on P2P transport in the dev milestone; transport encryption is an
  open production item [D-21].
