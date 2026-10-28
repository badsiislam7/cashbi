/**
 * CashBI protocol parameters.
 *
 * IMPORTANT: every value in this file is a DEVELOPMENT DEFAULT, not a final
 * consensus constant. Choosing permanent economic/technical parameters
 * (max supply, issuance, block time, retarget windows, chain id, initial
 * difficulty, genesis allocation, and more) requires the open community
 * decisions tracked in /UNRESOLVED_DECISIONS.md. Do NOT treat these numbers
 * as consensus-critical commitments across releases: dev releases may change
 * them, and they are versioned via the DEV_PARAM_VERSION constant so mixed
 * deployments fail loudly in handshake and genesis-hashing.
 */

/** Bumped whenever any dev default below changes.
 *  NOTE: this value is intentionally NOT bumped in the consensus-redesign
 *  task because the parameter-version bump is coupled to a genesis/protocol
 *  activation review (activation requires a coordinated version bump — see
 *  the redesign report). While it stays "0.0.1-dev", code must not silently
 *  treat dev chains as production chains. */
export const DEV_PARAM_VERSION = "0.0.1-dev";

/** Number of base units per BIC: dev default 18 decimals (decision D-2 open). */
export const DECIMALS = 18n;

/** BIC-denominated amount -> base units. */
export function BIC(count: bigint): bigint {
  return count * 10n ** DECIMALS;
}

/** Fixed maximum coin supply: 16,000,000 BIC (task-approved target;
 *  D-1 remains open for the issuance schedule inside this cap). */
export const MAX_TOTAL_SUPPLY = 16_000_000n * BIC(1n);

/** Network chain id: dev default 901_291 (EIP-155 style, decision D-3 open). */
export const DEV_CHAIN_ID = 901291;

/** Consensus/genesis dev defaults (decisions D-4..D-8 open). */
/** Initial mining difficulty — the approved target is "difficulty 1.0"
 *  (task-approved consensus redesign). With the difficulty→target mapping in
 *  src/consensus/pow.ts, difficulty 1 means target = 2^256, i.e. EVERY digest
 *  passes: instant dev mining while the rules stay well-defined. */
export const GENESIS_DIFFICULTY = 1;
/** Target block interval: 600 s = 10 minutes (task-approved target). */
export const TARGET_BLOCK_TIME_SECONDS = 600;
/** Retarget every 1,536 blocks (task-approved target). */
export const DIFFICULTY_RETARGET_INTERVAL = 1536;
/** Difficulty floor. The approved per-retarget bounds are relative (max 4x up,
 *  max down to one quarter of the previous difficulty); the only absolute
 *  floor is 1 = the initial difficulty 1.0 (griefing/persistence floor). */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 4_294_967_295; // dev cap to keep mining bounded

/** Bitcoin mainnet difficulty-1 proof-of-work limit: compact target 0x1d00ffff.
 *  At difficulty 1 this is the maximum permitted target, so difficulty 1
 *  requires real proof of work (~2^32 expected hashes) rather than accepting
 *  every digest. */
export const POW_LIMIT = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;

/** Maximum seconds a block timestamp may exceed its PARENT's timestamp
 *  (parent-relative bound, Phase 1 consensus rule). Equal timestamps are
 *  permitted. Derived from the target block interval: a stamp may not get
 *  ahead of its parent by more than one target interval (600 s). This pairs
 *  with MAX_FUTURE_TIMESTAMP_SECONDS which bounds stamps relative to the
 *  local wall clock. */
export const MAX_TIMESTAMP_STEP_SECONDS = TARGET_BLOCK_TIME_SECONDS;

/** Coinbase block reward: the ACTIVE dev issuance — explicitly identified:
 *  2 BIC per block, no halving, no tail (this is NOT the target production
 *  schedule; see src/consensus/issuance.ts for the prepared configurable
 *  schedule whose initial reward and halving interval are intentionally
 *  undecided; decision D-1 open). */
export const BLOCK_REWARD = BIC(2n);

/** Gas schedule: dev defaults (decision D-9 open); nominal EVM-style costs. */
export const CONSENT_TX_GAS = 21_000n;
export const CREATE_TX_GAS = 53_000n;
export const BASE_OPCODE_GAS = 3n;
export const MEMORY_OPCODE_GAS = 3n;
export const STORAGE_GAS = 20_000n;
export const EXPENSIVE_OPCODE_GAS = 100n;
export const MAX_BLOCK_GAS = 30_000_000n; // dev block gas limit (D-10 open)

/** Networking dev defaults (decision D-11..D-13 open). */
export const DEV_NETWORK_VERSION = 1;
export const P2P_PROTOCOL = "cashbi/0.1";
export const DEFAULT_P2P_PORT = 30_303;
export const DEFAULT_RPC_PORT = 8_545;
export const MAX_PEERS = 32;
export const MAX_PENDING_PEERS = 96;
export const P2P_FRAME_LIMIT_BYTES = 8 * 1024 * 1024;

/** Maximum number of seconds a block's timestamp may exceed its parent's timestamp.
 *  Prevents a miner from setting a block timestamp arbitrarily far in the future,
 *  which would artificially inflate the elapsed time used in difficulty retargeting
 *  and cause difficulty to drop. A value of 300 seconds (5 minutes) provides
 *  reasonable tolerance for clock skew while preventing timestamp manipulation. */
export const MAX_FUTURE_TIMESTAMP_SECONDS = 300;

/**
 * Peer discovery is operator-configured: DNS seed hostnames, HTTPS discovery
 * endpoints, and manual seeds are supplied through configuration. The repo
 * MUST NOT hardcode peer IP addresses (see SECURITY.md + test/discovery.test.ts).
 */
export interface DevDiscoveryDefaults {
  dnsSeedHostnames: string[]; // none: populated by community decision later
  httpsDiscoveryEndpoints: string[]; // none: populated by community decision later
  peerCacheFile: string; // relative file name inside the data directory
  peerCacheSaveIntervalMs: number;
}
export const DEV_DISCOVERY_DEFAULTS: DevDiscoveryDefaults = {
  dnsSeedHostnames: [],
  httpsDiscoveryEndpoints: [],
  peerCacheFile: "peers.json",
  peerCacheSaveIntervalMs: 60_000,
};

/** PoW mining resource limit: dev default is a moderate CPU budget. */
export const DEV_MINING_HASH_RATE = 512; // sha256d/sec budget per node (throttled)
export const DEV_MINING_CONSENT_FILE = "mining-consent.json";

/** Runtime tuning for the dev node (not consensus-relevant). */
export const MAX_TX_BYTES = 1 << 20;
export const MAX_BLOCK_BYTES = 16 << 20;
export const MAX_MEMPOOL_TXS = 10_000;
export const MAX_PENDING_BLOCKS = 2048;
export const PEER_KEEPALIVE_MS = 30_000;
export const PEER_BAN_MS = 60_000;
