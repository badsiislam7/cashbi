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

/** Bumped whenever any dev default below changes. */
export const DEV_PARAM_VERSION = "0.0.1-dev";

/** Number of base units per BIC: dev default 18 decimals (decision D-2 open). */
export const DECIMALS = 18n;

/** BIC-denominated amount -> base units. */
export function BIC(count: bigint): bigint {
  return count * 10n ** DECIMALS;
}

/** Fixed maximum coin supply — DEV DEFAULT (decision D-1 open). */
export const MAX_TOTAL_SUPPLY = 100_000_000n * BIC(1n);

/** Network chain id: dev default 901_291 (EIP-155 style, decision D-3 open). */
export const DEV_CHAIN_ID = 901291;

/** Consensus/genesis dev defaults (decisions D-4..D-8 open). */
export const GENESIS_DIFFICULTY = 1; // effectively instant mining for dev chains
export const TARGET_BLOCK_TIME_SECONDS = 1; // dev: sub-minute stragglers OK
export const DIFFICULTY_RETARGET_INTERVAL = 60; // blocks between retargets
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 4_294_967_295; // dev cap to keep mining bounded

/** Coinbase block reward: dev default, subject to decision D-1 (issuance). */
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
export const DEV_MINING_HASH_RATE = 512; // keccak/sec budget per node (throttled)
export const DEV_MINING_CONSENT_FILE = "mining-consent.json";

/** Runtime tuning for the dev node (not consensus-relevant). */
export const MAX_TX_BYTES = 1 << 20;
export const MAX_BLOCK_BYTES = 16 << 20;
export const MAX_MEMPOOL_TXS = 10_000;
export const MAX_PENDING_BLOCKS = 2048;
export const PEER_KEEPALIVE_MS = 30_000;
export const PEER_BAN_MS = 60_000;
