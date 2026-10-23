# SECURITY — CashBI (development build)

## Status

**NOT production-audited.** CashBI is an active development project. No formal
security review has been performed. Do not run on any network carrying value,
and do not treat dev defaults as hardened parameters.

## Threat model (dev assumptions)

- Nodes are run by consenting operators; mining requires explicit opt-in.
- P2P transport is unauthenticated TCP (no TLS yet); peers may be malicious.
- All protocol parameters are dev defaults and may change between releases
  (handshake + genesis-hash prevent silent chain splits).
- Keyfiles stored unencrypted in the data directory (`wallet.json`, 0o600).

## Known dev limitations (must be re-evaluated before launch)

| Item | Dev behavior | Decision |
|---|---|---|
| State root | `keccak256` of JSON serialization (no MPT proofs) | D-14 |
| Gas on EVM failure | Full gasLimit charged | dev rule |
| EVM coverage | miniEVM subset; CALL/CREATE/logs unsupported → revert | D-15 |
| Storage | JSONL ledger, no pruning | D-18 |
| Mining | CPU keccak, consent-gated, throttle only | D-19 |
| Key storage | Unencrypted in data dir | D-21 |

## Hard guards (enforced in code + tests)

- **No hardcoded peer IP addresses** anywhere in `src/`. Peer addresses arrive
  at runtime from DNS seeds / HTTPS feeds / cache / gossip / operator input.
  `test/security.test.ts` asserts this.
- **Genesis/chain identity**: peers with mismatched chainId or genesisHash are
  dropped during HELLO; a data dir with a mismatched genesis manifest is refused.
- **Frame limits**: `P2P_FRAME_LIMIT_BYTES` caps inbound frames; oversized
  frames ban the peer.
- **Consent gate**: `Miner.startMining()` fails without prior `grantConsent()`.
- **Supply cap**: block acceptance rejects any block pushing total supply over
  `MAX_TOTAL_SUPPLY`.

## Reporting

Security concerns: open an issue in this repository (do not email maintainers;
there is no security contact yet [D-21]).
