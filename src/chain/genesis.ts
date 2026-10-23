/**
 * Genesis block construction.
 *
 * The genesis hash pins the chain identity together with the chain id.
 * Genesis allocations and the genesis difficulty/timestamp are OPERATOR
 * configuration for devnets; there is NO production mainnet genesis yet
 * (see UNRESOLVED_DECISIONS.md, D-4 and D-8). A chain whose peers disagree
 * about the genesis hash will not sync.
 */
import { DEV_CHAIN_ID, DEV_PARAM_VERSION, GENESIS_DIFFICULTY, MAX_BLOCK_GAS } from "../config/params.js";
import type { Block, BlockHeader } from "./block.js";
import { blockHash, transactionsRoot } from "./block.js";
import type { Transaction } from "../tx/transaction.js";
import { WorldState } from "../state/world.js";

export interface GenesisAllocationEntry {
  address: string;
  balance: bigint;
}

export interface GenesisConfig {
  chainId: number;
  /** Devynet/seed allocations (operated via config; mainnet genesis is unresolved). */
  allocations: GenesisAllocationEntry[];
  /** Unix seconds of the genesis block. */
  timestamp: number;
  extraData: Uint8Array;
}

export function emptyGenesisConfig(timestamp = 0): GenesisConfig {
  return {
    chainId: DEV_CHAIN_ID,
    allocations: [],
    timestamp,
    extraData: new TextEncoder().encode("cashbi-dev-genesis"),
  };
}

export function genesisHeader(config: GenesisConfig): BlockHeader {
  const transactions: Transaction[] = [];
  return {
    parentHash: "0x" + "00".repeat(32),
    number: 0,
    timestamp: config.timestamp,
    difficulty: BigInt(GENESIS_DIFFICULTY),
    coinbase: "0x" + "00".repeat(20),
    extraData: config.extraData,
    gasLimit: MAX_BLOCK_GAS,
    gasUsed: 0n,
    transactionsRoot: transactionsRoot(transactions),
    stateRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    nonce: 0n,
  };
}

/**
 * Builds the genesis block and initial world state.
 * The stateRoot recorded in the genesis header is filled in after state
 * initialization so that it matches the allocation set.
 */
export function buildGenesis(config: GenesisConfig): { block: Block; state: WorldState } {
  const state = WorldState.fromGenesisAllocations(config.allocations);
  const header = genesisHeader(config);
  header.stateRoot = state.stateRoot();
  const block: Block = { header, transactions: [] };
  return { block, state };
}

export function genesisBlockHash(config: GenesisConfig): string {
  return blockHash(buildGenesis(config).block.header);
}

/** Marker stored alongside chain data so mismatched deployments fail fast. */
export interface GenesisManifest {
  paramVersion: string;
  chainId: number;
  genesisHash: string;
  genesisTimestamp: number;
  allocationCount: number;
}

export function genesisManifest(config: GenesisConfig): GenesisManifest {
  return {
    paramVersion: DEV_PARAM_VERSION,
    chainId: config.chainId,
    genesisHash: genesisBlockHash(config),
    genesisTimestamp: config.timestamp,
    allocationCount: config.allocations.length,
  };
}
