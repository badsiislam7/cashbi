# Unresolved Decisions — CashBI

**Status: active development.** Every permanent economic, consensus, and
protocol parameter of a real Layer 1 network is a long-lived community
commitment. Nothing in this repository is production-ready, so **no permanent
consensus parameters have been chosen**. The values in `src/config/params.ts`
are clearly labeled **dev defaults** chosen only to make local testing
practical. They are versioned via `DEV_PARAM_VERSION` so that mixed dev
deployments fail loudly (HELLO handshake + genesis-hash mismatch) rather than
silently disagreeing.

Rule (from the project plan): **do not invent permanent consensus parameters.**
The decisions below must be made explicitly (and published with a rationale)
before any network carries value. Each decision lists the current dev default
for context.

---

## Economic parameters

### D-1 — Maximum supply and issuance schedule — OPEN
Fixed maximum coin supply is a spec requirement, but the number itself and the
distribution of rewards are unresolved.
- Dev default: `MAX_TOTAL_SUPPLY = 100,000,000 BIC`; `BLOCK_REWARD = 2 BIC`
  per block, flat (no halving, no tail, no decay curve).
- Open questions: final cap, reward curve (halving / decaying / tail-emission),
  pre-mine vs. none, genesis allocation and its justification.

### D-2 — Coin decimals — OPEN
- Dev default: 18 base units per BIC (matches Ethereum convention for
  tooling compatibility).
- Alternative: fewer decimals (e.g. 8–9) to mirror familiar cash denominations.

### D-3 — Chain id — OPEN
- Dev default: `901291` (EIP-155-style replay protection domain; not
  registered against any public ledger of chain ids).

### D-4 — Genesis specification and distribution — OPEN
- Dev default: `emptyGenesisConfig()` produces an allocation-free genesis
  ("cashbi-dev-genesis") used by devnets/tests; operators may supply devnet
  allocations at node start. **No public mainnet genesis exists.**
- Open questions: hard-coding the canonical genesis header, ICO/airdrop
  policy (if any), whether the genesis must embed a validator/observer set.

### D-5 — Difficulty adjustment algorithm and bounds — OPEN
- Dev default: bounded linear correction every
  `DIFFICULTY_RETARGET_INTERVAL = 60` blocks with a hard clamp of
  ×1/4 … ×4 per retarget, difficulty clamped to `[1, 4,294,967,295]`.
- Open questions: retarget algorithm family (linear vs. PID vs.
  brake-buffer), window size, per-retarget clamp, and the permanent
  difficulty floor/ceiling.

### D-6 — Genesis difficulty — OPEN
- Dev default: `GENESIS_DIFFICULTY = 1` (effectively instant mining so
  devnets bootstrap in seconds).

### D-7 — Target block time — OPEN
- Dev default: `TARGET_BLOCK_TIME_SECONDS = 1` — far faster than a
  production CPU-PoW network would sustain; chosen so tests finish quickly.

### D-8 — Difficulty floor and ceiling — OPEN
- Dev defaults: `MIN_DIFFICULTY = 1`, `MAX_DIFFICULTY = 2^32 − 1`
  (a deliberately low dev cap so CPU mining stays viable). A permanent
  ceiling affects the retarget's error bounds and must be chosen with D-5.

## Execution / gas

### D-9 — Gas schedule — OPEN
- Dev default: nominal EVM-style keys — `21000` (transfer) / `53000`
  (create) intrinsic, `3` for cheap opcodes, `20000` per SSTORE store,
  `100` for expensive opcodes. Not the full Ethereum Yellow Paper schedule
  (no memory-word expansion quadratic component, no cold/warm access,
  no 6-byte dynamic memory model). Fees go fully to the coinbase
  (no burned base fee; EIP-1559-style mechanics are an alternative).

### D-10 — Block gas limit — OPEN
- Dev default: `MAX_BLOCK_GAS = 30,000,000`. No adjustment mechanism
  (e.g. Ethereum's dynamic elasticity) exists yet.

## Networking / protocol

### D-11 — Protocol and network versioning — OPEN
- Dev default: `P2P_PROTOCOL = "cashbi/0.1"`, `DEV_NETWORK_VERSION = 1`.
  Handshake rejects mismatched versions; the exact upgrade/cross-version
  policy is unresolved.

### D-12 — Default ports — OPEN
- Dev defaults: TCP P2P `30303`, JSON-RPC HTTP `8545` (Ethereum-familiar so
  tooling is easy to point at a dev node). Non-binding; operator config wins.

### D-13 — Peer bounds and frame limits — OPEN
- Dev defaults: `MAX_PEERS = 32`, `MAX_PENDING_PEERS = 96`,
  `P2P_FRAME_LIMIT_BYTES = 8 MiB`. Public-network values (and DoS-shaping
  policy around inbound slots) are open.

## State / execution scheme

### D-14 — State commitment model — OPEN
- Dev default: the state root is `keccak256` of the JSON serialization of the
  world state — **not** a Merkle-Patricia-Trie. This makes light-client
  proofs and third-party state verification impossible; replacing it with an
  MPT (or Merkle-ized AVL/JMT) is a prerequisite for any public network.

### D-15 — EVM coverage — OPEN
- Dev default: the "miniEVM" interpreter implements a documented subset
  (arithmetic, comparison, bitwise, memory, storage, context, jump-based
  control flow, RETURN/REVERT). Missing: precompiles, CALL/DELEGATECALL/
  CREATE, logs, and gas-accurate memory accounting. Decision: which opcode
  set is the target (full Yellow Paper vs. subset), and whether Solidity/
  Vyper bytecode compatibility is a requirement.

### D-16 — Fork-choice retention policy — OPEN
- Dev default: cumulative-difficulty fork choice with in-memory retention of
  the last `512` blocks' post-states. Long-range reorganizations beyond the
  retention window cannot re-enter without resync. Production policy (how
  many states to retain, checkpointing) is open.

### D-17 — Canonical encoding commitments — OPEN
- Dev default: RLP for signed transactions and headers, JSON for RPC/ledger
  framing. Binding the format (and the block-hash preimage) permanently is
  a protocol-identity decision.

### D-18 — Storage engine — OPEN
- Dev default: in-memory indexes + an append-only JSONL ledger
  (`blocks.jsonl`) per data directory. Production needs a real embedded
  storage engine (e.g. LMDB/RocksDB) with pruning and block-body separation.

### D-19 — Mining resource governance — OPEN
- Dev default: CPU mining behind an **explicit consent gate** (CLI flag or
  typed confirmation) and a configurable keccak/sec throttle
  (`--mining-rate`, default 512 H/s). Whether to add further policy controls
  (by default-off opt-in, per-platform power caps, GPU ASIC-proofs) is open.

## Governance / process

### D-20 — Seed infrastructure — OPEN
DNS seed hostnames and HTTPS discovery endpoints are **intentionally empty**
(`DEV_DISCOVERY_DEFAULTS`). Populating them means choosing who operates that
infrastructure on behalf of the network. No peer IP addresses are hardcoded
anywhere in the source tree (`test/security.test.ts` enforces this).

### D-21 — Security posture — ONGOING
No formal audit has taken place. The dev consensus rules contain
**deliberate simplifications that must not survive into a value-bearing
network**, notably:
- full `gasLimit` charged on EVM failure (dev rule),
- JSON-serialized state roots (D-14),
- single-node-friendly genesis/difficulty defaults,
- unencrypted keyfile storage in the data directory.

Each must be re-evaluated against D-… before launch.

### D-22 — Initial block reward — OPEN
Dev default remains `BLOCK_REWARD = 2 BIC` per block, flat (no halving, no
tail); this is explicitly dev-only and is NOT a production decision
(`src/config/params.ts`, `src/consensus/issuance.ts`). The production
issuance schedule (initial reward, halving interval, tail behavior) must not
be defaulted anywhere — `scheduleRewardAt` rejects an unconfigured schedule
with an explicit error rather than inventing a value.

### D-23 — Halving interval — OPEN
No halving interval may be assumed or invented (task rule). The issuance
framework accepts `halvingInterval: number | null` with explicit validation;
`null` is the current state and must not be coerced into a value.

### D-24 — Consensus parameter-version activation — OPEN
`DEV_PARAM_VERSION` intentionally stays `"0.0.1-dev"` in this task: the bump
is coupled to genesis/protocol activation review. HELLO rejects a present but
differing `paramVersion` (additive, non-breaking); peers that omit the field
(pre-2 protocol) are still accepted until enforcement is hardened at launch.
Genesis-hash alone does NOT change when consensus parameters change, so the
version string is the only wire-level protection against silent rule mixing
until activation.

### D-25 — Best-chain ledger floor limits for deep forks — OPEN
The retarget fix adds `bestChainTimestamps`/`bestChainHashes` plus
`reconcileBestChainLedger()` so retarget anchors survive fork-retention
pruning (anchor depth INTERVAL + 9 > FORK_RETENTION). The verified-shared-
prefix walk raises `bestChainTsFloor` to the deepest unverified height when
the walk is interrupted (fail-closed). Additional bounds for very deep or
long forks — e.g. ledger size caps, floor persistence across restarts — are
undecided.
