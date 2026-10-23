# Mining — CashBI Proof-of-Work

## Algorithm

CashBI PoW is real CPU mining, not a simulation:

```
target = 2^256 / difficulty
powHash(header, nonce) = keccak256( keccak256(RLP(header-without-nonce)) || 8-byte-BE(nonce) )
valid  ⇔  powHash <= target
```

The miner builds a candidate block template (`buildBlockForMining` on tip, or
`buildBlockOn` for forking on an arbitrary parent), then searches nonces from 0
upward until `isMiningCandidate` succeeds.

## Block template construction

A template includes:
- fee-sorted, nonce-consistent tx prefix from the mempool (per-sender sequence
  enforced; txs already in the parent are skipped)
- replay against the parent's post-state to compute `gasUsed`, `transactionsRoot`,
  `stateRoot`
- coinbase block reward added to the template state so validation passes unchanged
- difficulty via `nextDifficulty` (retarget cadence + bounded bounds)

## Consent gate (mandatory)

Mining **never starts without explicit user consent**. Fail-closed:

1. `Miner.startMining()` throws if `grantConsent()` was not called first.
2. CLI obtains consent via `--allow-mining` flag, or an interactive typed `"YES"`
   prompt (TTY only). Absence of both → mining stays disabled.
3. Consent is recorded (`grantedAt`, `source`) and exposed via `bic_mineStatus`.

CPU mining consumes compute resources; the node never mines silently.

## Resource limits

`--mining-rate <hashes/sec>` caps the keccak/sec budget by inserting blocking
micro-delays between hash batches (default 512 H/s; 0 = unlimited, not
recommended). This keeps the CPU footprint modest on dev hardware. [D-19]

## Fork mining

`buildBlockOn` lets a node mine on any known parent given its post-state, which
is the primitive behind real fork/reorg competition. A miner always builds on the
local best chain; a competitor with more cumulative difficulty can overtake.

## Dev defaults (not production commitments)

| Parameter | Default | Decision |
|---|---|---|
| GENESIS_DIFFICULTY | 1 | D-6 |
| TARGET_BLOCK_TIME_SECONDS | 1 | D-7 |
| BLOCK_REWARD | 2 BIC | D-1 |
| Mining hash rate | 512 H/s | D-19 |

## Security

- No GPU/ASIC resistance claim in dev milestone (keccak/sec budget only).
- Consent gate prevents accidental resource consumption.
- Mining reward is subject to the supply-cap check; over-cap blocks are rejected.
