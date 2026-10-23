/**
 * Full node orchestration: wires blockchain, mempool, P2P networking,
 * discovery and the miner into one running CashBI node.
 *
 * Responsibilities:
 *  - Load or initialize the chain and the append-only ledger.
 *  - Maintain outbound connections and auto-ban misbehaving peers.
 *  - Propagate blocks and transactions (gossip).
 *  - Run block sync against peers with larger best numbers.
 *  - Persist the peer cache and wallet-free configuration state.
 *
 * Mining is only enabled when: (a) the operator passed the consent flag or
 * answered the interactive prompt, AND (b) a coinbase address is available.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Blockchain } from "../chain/blockchain.js";
import { Mempool } from "../tx/mempool.js";
import { decodeBlock, encodeBlock, blockHash } from "../chain/block.js";
import { decodeSignedTransaction, encodeSignedTransaction, type Transaction } from "../tx/transaction.js";
import { emptyGenesisConfig, type GenesisConfig, type GenesisAllocationEntry } from "../chain/genesis.js";
import { P2PServer, type PeerInfo } from "../net/server.js";
import { PeerDiscovery, defaultDiscoveryConfig } from "../net/discovery.js";
import { splitPeerAddress } from "../util/peer.js";
import { Miner, type MinerStatus } from "../mining/miner.js";
import {
  DEV_CHAIN_ID,
  DEV_MINING_HASH_RATE,
  DEFAULT_P2P_PORT,
  DEFAULT_RPC_PORT,
  MAX_PEERS,
  MAX_PENDING_PEERS,
  DEV_DISCOVERY_DEFAULTS,
} from "../config/params.js";
import { toHex, fromHex } from "../util/bytes.js";
import { DEV_PARAM_VERSION } from "../config/params.js";

export interface NodeConfig {
  dataDir: string;
  p2pPort: number;
  p2pHost: string;
  rpcEnabled: boolean;
  rpcPort: number;
  addPeers: string[];
  dnsSeeds: string[];
  discoveryUrls: string[];
  /** Consent already granted via CLI/prompt (checked by Miner again). */
  allowMining: boolean;
  miningHashRate: number;
  coinbase: string | null;
  /** Optional operator genesis overrides (used by devnet runners/tests). */
  genesisTimestamp?: number;
  genesisAllocations?: GenesisAllocationEntry[];
}

export function defaultNodeConfig(dataDir: string): NodeConfig {
  return {
    dataDir,
    p2pPort: DEFAULT_P2P_PORT,
    p2pHost: "127.0.0.1",
    rpcEnabled: true,
    rpcPort: DEFAULT_RPC_PORT,
    addPeers: [],
    dnsSeeds: [...DEV_DISCOVERY_DEFAULTS.dnsSeedHostnames],
    discoveryUrls: [...DEV_DISCOVERY_DEFAULTS.httpsDiscoveryEndpoints],
    allowMining: false,
    miningHashRate: DEV_MINING_HASH_RATE,
    coinbase: null,
  };
}

export class FullNode {
  readonly chain: Blockchain;
  readonly mempool: Mempool;
  private readonly p2p: P2PServer;
  readonly discovery: PeerDiscovery;
  miner: Miner | null = null;
  private started = false;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly config: NodeConfig,
    genesisConfigOverride?: GenesisConfig | null,
  ) {
    const genesis = genesisConfigOverride ?? this.genesisFromConfig(config);
    this.chain = this.loadChain(config.dataDir, genesis);
    this.mempool = new Mempool();
    this.chain.mempoolRef = this.mempool;
    this.p2p = new P2PServer({
      chainId: genesis.chainId,
      genesisHash: this.chain.genesis.genesisHash,
      paramVersion: DEV_PARAM_VERSION,
      networkVersion: 1,
    });
    const discoveryConfig = defaultDiscoveryConfig();
    discoveryConfig.manualAddresses = config.addPeers;
    discoveryConfig.dnsSeedHostnames = config.dnsSeeds;
    discoveryConfig.httpsEndpoints = config.discoveryUrls;
    const cacheName = DEV_DISCOVERY_DEFAULTS.peerCacheFile;
    const cachePath = join(config.dataDir, cacheName);
    discoveryConfig.peerCachePath = cachePath;
    this.discovery = new PeerDiscovery(discoveryConfig);
    this.wireNetworking();
  }

  private genesisFromConfig(config: NodeConfig): GenesisConfig {
    const genesis = emptyGenesisConfig(config.genesisTimestamp ?? 0);
    if (config.genesisAllocations && config.genesisAllocations.length > 0) {
      genesis.allocations = config.genesisAllocations;
    }
    if (genesis.chainId !== DEV_CHAIN_ID && !process.env["CASHBI_ALLOW_CHAIN_ID_OVERRIDE"]) {
      throw new Error("chain id override requires CASHBI_ALLOW_CHAIN_ID_OVERRIDE");
    }
    return genesis;
  }

  private loadChain(dataDir: string, genesis: GenesisConfig): Blockchain {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    else if (!existsSync(dirname(dataDir))) throw new Error("data directory parent missing");
    const ledgerPath = join(dataDir, "blocks.jsonl");
    if (existsSync(ledgerPath)) {
      const chain = Blockchain.loadFromLedger(genesis, ledgerPath);
      const storedManifestPath = join(dataDir, "genesis.json");
      if (existsSync(storedManifestPath)) {
        const stored = JSON.parse(readFileSync(storedManifestPath, "utf8"));
        if (stored.genesisHash !== chain.genesis.genesisHash) {
          throw new Error(
            "stored genesis hash mismatch — refusing to continue on a different chain " +
            `(file ${stored.genesisHash}, rederived ${chain.genesis.genesisHash}). ` +
            "Point --data at the original directory or delete this dev datadir consciously.",
          );
        }
      }
      chain.enablePersistence(ledgerPath);
      return chain;
    }
    const chain = new Blockchain(genesis);
    chain.enablePersistence(ledgerPath);
    ensureFile(join(dataDir, "genesis.json"), JSON.stringify(chain.genesis, null, 2));
    return chain;
  }

  private wireNetworking(): void {
    this.p2p.on("peerConnected", (peer) => {
      void this.onPeerConnected(peer);
    });
    this.p2p.on("peerDisconnected", () => {
      /* housekeeping only: keepalive timer prunes below */
    });
    this.p2p.on("bestNumber", (peer, number, hash) => {
      void this.onPeerTipUpdate(peer, number, hash);
    });
    this.p2p.on("blocksRequest", (peer, startNumber, maxCount) => {
      this.serveBlocks(peer, startNumber, maxCount);
    });
    this.p2p.on("blockAnnouncement", (peerId, payloadHex) => {
      void this.onExternalBlock(peerId, payloadHex);
    });
    this.p2p.on("txAnnouncement", (peerId, payloadHex) => {
      void this.onExternalTx(peerId, payloadHex);
    });
    this.p2p.on("peersAnnouncement", (peerId, peers) => {
      this.discovery.addFromGossip(peers, peerId);
    });
  }

  /** Starts P2P + discovery + maintenance; optionally mining (with consent). */
  async start(): Promise<void> {
    if (this.started) throw new Error("node already started");
    // Peer cache load
    const cachePath = join(this.config.dataDir, DEV_DISCOVERY_DEFAULTS.peerCacheFile);
    if (existsSync(cachePath)) {
      this.discovery.loadCache(readFileSync(cachePath, "utf8"));
    }
    // Manual peers enter first
    this.discovery.viaManual();
    await this.p2p.listen(this.config.p2pPort, this.config.p2pHost);
    // Initial connects
    await this.connectEligibleCandidates();
    // DNS/HTTPS discovery warmed in background (must never block startup)
    void this.runDiscoveryCycle().catch(() => {});
    this.discovery.startPeriodicSaving(() => this.persistPeerCache());
    this.maintenanceTimer = setInterval(() => void this.maintenance(), 10_000);
    this.maintenanceTimer.unref();

    // Mining: only with explicit consent + coinbase.
    if (this.config.allowMining) {
      const coinbase = this.config.coinbase ?? this.walletCoinbase();
      if (!coinbase) {
        throw new Error(
          "mining consent granted but no coinbase: run `cashbi keygen` in the same data dir, or pass --coinbase",
        );
      }
      this.miner = new Miner(this.chain, this.mempool, {
        coinbase,
        hashRatePerSecond: this.config.miningHashRate,
        onMinedBlock: (block) => void this.submitMinedBlock(block),
      });
      this.miner.grantConsent("cli-flag");
      this.miner.startMining();
    }
    this.started = true;
  }

  /** Counts a mined block once consensus accepts it. */
  private submitMinedBlock(block: ReturnType<typeof decodeBlock>): boolean {
    const receipt = this.chain.acceptBlock(block);
    if (!receipt.accepted) return false;
    this.p2p.broadcast({ type: "NEW_BLOCK", block: toHex(encodeBlock(block)) });
    return true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.miner?.stop();
    await this.miner?.closed();
    await this.discovery.stop();
    await this.p2p.close();
    this.mempool.close();
    this.persistPeerCache();
  }

  minerStatus(): MinerStatus | null {
    return this.miner?.status() ?? null;
  }

  peerCount(): number {
    return this.p2p.peerCount();
  }

  /** Submits a locally signed transaction (RPC or CLI entry point). */
  submitTransaction(tx: Transaction): { accepted: boolean; hash: string; reason?: string } {
    const added = this.mempool.add(tx, { chainId: this.chain.chainId, state: this.chain.tipState });
    if (added.added) {
      this.p2p.broadcast({ type: "NEW_TX", tx: toHex(encodeSignedTransaction(tx)) });
    }
    return { accepted: added.added, hash: added.hash, reason: added.reason };
  }

  private walletCoinbase(): string | null {
    const walletPath = join(this.config.dataDir, "wallet.json");
    if (!existsSync(walletPath)) return null;
    try {
      const wallet = JSON.parse(readFileSync(walletPath, "utf8")) as { address?: string };
      return wallet.address ?? null;
    } catch {
      return null;
    }
  }

  private async onPeerConnected(peer: PeerInfo): Promise<void> {
    this.p2p.sendHelloWithTip(peer, this.chain.tip.number, this.chain.tip.hash);
    this.p2p.sendMessage(peer, { type: "GET_PEERS" });
    if (peer.bestNumber > this.chain.tip.number) {
      this.p2p.requestBlocks([peer], this.chain.tip.number + 1, 128);
    }
  }

  private async onPeerTipUpdate(peer: PeerInfo, number: number, hash: string): Promise<void> {
    if (number > this.chain.tip.number) {
      this.p2p.requestBlocks([peer], this.chain.tip.number + 1, 128);
    }
    void hash;
  }

  private serveBlocks(peer: PeerInfo, startNumber: number, maxCount: number): void {
    const boundedCount = Math.max(1, Math.min(256, maxCount));
    const start = Math.max(0, startNumber);
    const blocks: string[] = [];
    for (let i = 0; i < boundedCount; i++) {
      const block = this.chain.getBlockByNumber(start + i);
      if (!block) break;
      blocks.push(toHex(encodeBlock(block)));
    }
    this.p2p.sendMessage(peer, {
      type: "BLOCKS",
      blocks,
      tipNumber: this.chain.tip.number,
      tipHash: this.chain.tip.hash,
    });
  }

  private async onExternalBlock(peerId: string, payloadHex: string): Promise<void> {
    let block;
    try {
      block = decodeBlock(fromHex(payloadHex));
    } catch {
      this.p2p.dropPeer(peerId); // malformed gossip — disconnect
      return;
    }
    const hash = blockHash(block.header);
    if (this.chain.getBlock(hash)) return; // already known
    const receipt = this.chain.acceptBlock(block);
    if (!receipt.accepted) {
      if ((receipt.reason ?? "").includes("unknown parent")) {
        // candidate child of an unknown parent — peer may still be honest
        return;
      }
      this.p2p.dropPeer(peerId);
      return;
    }
    // Gossip onward (excluding the originator).
    this.p2p.broadcast({ type: "NEW_BLOCK", block: payloadHex }, peerId);
  }

  private async onExternalTx(peerId: string, payloadHex: string): Promise<void> {
    let tx: Transaction;
    try {
      // External tx gossip carries the FULL signed tx; decode accordingly.
      tx = decodeSignedTransaction(fromHex(payloadHex));
    } catch {
      this.p2p.dropPeer(peerId);
      return;
    }
    const added = this.mempool.add(tx, { chainId: this.chain.chainId, state: this.chain.tipState });
    if (added.added) {
      this.p2p.broadcast({ type: "NEW_TX", tx: payloadHex }, peerId);
    }

  }

  private async runDiscoveryCycle(): Promise<void> {
    const viaDns = await this.discovery.viaDns();
    const viaHttps = await this.discovery.viaHttps();
    void viaDns;
    void viaHttps;
    await this.connectEligibleCandidates();
  }

  private async connectEligibleCandidates(): Promise<void> {
    if (this.p2p.peerCount() >= MAX_PEERS) return;
    for (const candidate of this.discovery.candidates()) {
      if (this.p2p.peerCount() >= MAX_PEERS) break;
      if (this.p2p.peerCount() + this.pendingOutbound() >= MAX_PENDING_PEERS) break;
      const split = splitPeerAddress(candidate);
      if (!split) continue;
      if (this.isSelfAddress(split.host, split.port)) continue;
      this.p2p.connect(split.host, split.port);
    }
  }

  private pendingOutbound(): number {
    return 0; // connect() is synchronous in net.Socket connect state; small dev cap suffices
  }

  private isSelfAddress(host: string, port: number): boolean {
    if (port !== this.config.p2pPort) return false;
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  }

  private async maintenance(): Promise<void> {
    // Drop stale peers (keepalive interval) and refresh connections.
    const now = Date.now();
    for (const peer of this.p2p.peerList) {
      if (now - peer.lastSeen > Math.max(60_000, 30_000 * 2)) {
        this.p2p.dropPeer(peer.id);
      } else {
        this.p2p.sendMessage(peer, { type: "PING" });
      }
    }
    if (this.p2p.peerCount() < MAX_PEERS) {
      await this.connectEligibleCandidates();
    }
    this.persistPeerCache();
  }

  private persistPeerCache(): void {
    const cachePath = join(this.config.dataDir, DEV_DISCOVERY_DEFAULTS.peerCacheFile);
    try {
      ensureFile(cachePath, this.discovery.serializeCache());
    } catch {
      // cache persistence failures are non-fatal for dev node operation
    }
  }
}

function ensureFile(path: string, contents: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}
