/**
 * Peer discovery subsystem.
 *
 * Independent mechanisms, per the project rules, with NO hard-coded peer IP
 * addresses in the repo:
 *
 *  1. DNS seeds    — operator-configured hostnames; A-records resolved at
 *                    runtime, default port from configuration.
 *  2. HTTPS feeds  — operator-configured discovery endpoints returning a
 *                    JSON list of "host:port" strings.
 *  3. Local cache  — persistent peers file in the data directory.
 *  4. Gossip       — peers share peer lists via the P2P protocol.
 *  5. Manual       — operator-supplied addresses (CLI/config).
 */
import { lookup } from "node:dns/promises";
import { DEV_DISCOVERY_DEFAULTS } from "../config/params.js";
import { parsePeerAddress } from "../util/peer.js";

export interface DiscoveryConfig {
  dnsSeedHostnames: string[];
  dnsSeedDefaultPort: number;
  httpsEndpoints: string[];
  manualAddresses: string[];
  /** Resolved path of the peer cache file inside the data directory. */
  peerCachePath: string | null;
  saveIntervalMs: number;
}

export function defaultDiscoveryConfig(): DiscoveryConfig {
  return {
    dnsSeedHostnames: [...DEV_DISCOVERY_DEFAULTS.dnsSeedHostnames],
    dnsSeedDefaultPort: 30_303,
    httpsEndpoints: [...DEV_DISCOVERY_DEFAULTS.httpsDiscoveryEndpoints],
    manualAddresses: [],
    peerCachePath: null,
    saveIntervalMs: DEV_DISCOVERY_DEFAULTS.peerCacheSaveIntervalMs,
  };
}

export class PeerDiscovery {
  private readonly addresses = new Map<string, string>(); // address -> source
  private saveTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private config: DiscoveryConfig) {}

  /** DNS seed resolution: hostname -> A records -> host:defaultPort. */
  async viaDns(): Promise<string[]> {
    const found: string[] = [];
    for (const hostname of this.config.dnsSeedHostnames) {
      if (this.stopping) break;
      try {
        const records = await lookup(hostname, { all: true });
        for (const record of records) {
          const candidate = parsePeerAddress(`${record.address}:${this.config.dnsSeedDefaultPort}`);
          if (candidate) found.push(candidate);
        }
      } catch {
        // DNS seed unreachable — other mechanisms compensate.
      }
    }
    return this.absorb(found, "dns");
  }

  /** HTTPS discovery feed: expects JSON {peers: ["host:port", ...]}. */
  async viaHttps(): Promise<string[]> {
    const found: string[] = [];
    for (const endpoint of this.config.httpsEndpoints.slice(0, 8)) {
      if (this.stopping) break;
      try {
        const response = await fetch(endpoint, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) continue;
        const payload = (await response.json()) as { peers?: string[] } | string[];
        const peerList = Array.isArray(payload) ? payload : (payload.peers ?? []);
        for (const raw of peerList) {
          const candidate = parsePeerAddress(raw);
          if (candidate) found.push(candidate);
        }
      } catch {
        // Unreachable discovery endpoint — skip.
      }
    }
    return this.absorb(found, "https");
  }

  /** Operator-supplied (CLI/--add-peer or config file) addresses. */
  viaManual(): string[] {
    return this.absorb(this.config.manualAddresses, "manual");
  }

  /** Gossip-fed peer announcements arrive through here. */
  addFromGossip(addresses: string[], announcePeer: string): string[] {
    return this.absorb(addresses, `gossip:${announcePeer}`);
  }

  private absorb(addresses: string[], source: string): string[] {
    const added: string[] = [];
    for (const raw of addresses) {
      const normalized = parsePeerAddress(raw);
      if (!normalized) continue;
      if (this.addresses.has(normalized)) continue;
      this.addresses.set(normalized, source);
      added.push(normalized);
    }
    return added;
  }

  candidates(): string[] {
    return [...this.addresses.keys()];
  }

  sourceOf(address: string): string | null {
    return this.addresses.get(address) ?? null;
  }

  forget(address: string): void {
    this.addresses.delete(address);
  }

  /** Loads the persistent cache file contents (JSON {peers: [..]}). */
  loadCache(json: string): string[] {
    let peers: string[] = [];
    try {
      const parsed = JSON.parse(json) as { peers?: string[] };
      peers = (parsed.peers ?? []).filter((a) => typeof a === "string");
    } catch {
      peers = [];
    }
    return this.absorb(peers, "cache");
  }

  /** Serialized cache: what loadCache expects on restart. */
  serializeCache(): string {
    return JSON.stringify({ peers: this.candidates() });
  }

  startPeriodicSaving(onSave: (context: string) => void): void {
    this.saveTimer = setInterval(() => onSave("periodic"), this.config.saveIntervalMs);
    this.saveTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.saveTimer) clearInterval(this.saveTimer);
  }

  replaceConfig(partial: Partial<DiscoveryConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
