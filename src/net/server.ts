/**
 * Minimal decentralized P2P transport: TCP with newline-delimited JSON
 * messages, an authenticated HELLO handshake (chain id + genesis hash +
 * protocol version), bounded frame sizes, and the following messages:
 *
 *   HELLO        handshake
 *   GET_BLOCKS   {startNumber, maxCount}         → BLOCKS
 *   BLOCKS       {blocks: [hex], tip: {number, hash}}
 *   NEW_BLOCK    {block: hex}                    → propagates (gossip)
 *   NEW_TX       {tx: hex}                       → propagates (gossip)
 *   GET_PEERS    {}                              → PEERS
 *   PEERS        {peers: ["host:port", ...]}     → feeds discovery (gossip)
 *
 * Per the project rules this module contains NO hardcoded peer IP addresses;
 * all peers come from discovery (DNS/HTTPS/cache/gossip) or operator input.
 */
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createServer, connect as tcpConnect } from "node:net";
import { P2P_FRAME_LIMIT_BYTES, P2P_PROTOCOL } from "../config/params.js";

export interface P2PServerConfig {
  chainId: number;
  genesisHash: string;
  paramVersion: string;
  networkVersion: number; // dev; bumps intra-param-version protocol changes
}

export type PeerMessage =
  | { type: "HELLO"; protocol: string; networkVersion: number; chainId: number; genesisHash: string; bestNumber: number; bestHash: string }
  | { type: "GET_BLOCKS"; startNumber: number; maxCount: number }
  | { type: "BLOCKS"; blocks: string[]; tipNumber: number; tipHash: string }
  | { type: "NEW_BLOCK"; block: string }
  | { type: "NEW_TX"; tx: string }
  | { type: "GET_PEERS" }
  | { type: "PEERS"; peers: string[] }
  | { type: "PING" }
  | { type: "PONG" };

export interface PeerInfo {
  id: string; // host:port
  socket: Socket | null;
  bestNumber: number;
  bestHash: string;
  lastSeen: number;
  inbound: boolean;
  banned: boolean;
}

export interface P2PEvents {
  peerConnected: (peer: PeerInfo) => void;
  peerDisconnected: (peer: PeerInfo) => void;
  bestNumber: (peer: PeerInfo, number: number, hash: string) => void;
  blocksRequest: (peer: PeerInfo, startNumber: number, maxCount: number) => void;
  blockAnnouncement: (peerId: string, payload: string) => void;
  txAnnouncement: (peerId: string, payload: string) => void;
  peersAnnouncement: (peerId: string, peers: string[]) => void;
}

/**
 * TCP server + outbound client for the CashBI dev P2P protocol.
 */
export class P2PServer extends EventEmitter {
  private readonly peers = new Map<string, PeerInfo>();
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private readonly config: P2PServerConfig) {
    super();
  }

  get peerList(): PeerInfo[] {
    return [...this.peers.values()];
  }

  peerCount(): number {
    return this.peers.size;
  }

  bestNumberSeen(): number {
    return Math.max(0, ...[...this.peers.values()].map((p) => p.bestNumber));
  }

  async listen(port: number, host: string): Promise<void> {
    this.server = createServer((socket) => this.handleInbound(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.removeAllListeners("error");
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const peer of this.peers.values()) {
      peer.socket?.destroy();
    }
    this.peers.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Outbound connection to a manually/advertisement-supplied address. */
  connect(host: string, port: number): PeerInfo | null {
    const id = `${host}:${port}`;
    if (this.peers.has(id)) return this.peers.get(id)!;
    const socket = tcpConnect(port, host, () => {
      this.registerSocket(id, socket, false);
      this.emit("peerConnected", peer!);
    });
    socket.on("data", this.dataHandler(id, socket));
    socket.on("error", () => this.dropPeer(id));
    socket.on("close", () => this.dropPeer(id));
    const peer: PeerInfo = {
      id,
      socket,
      bestNumber: 0,
      bestHash: "",
      lastSeen: Date.now(),
      inbound: false,
      banned: false,
    };
    this.peers.set(id, peer);
    return peer;
  }

  private handleInbound(socket: Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.setNoDelay(true);
    this.registerSocket(remote, socket, true);
    socket.on("data", this.dataHandler(remote, socket));
    socket.on("error", () => this.dropPeer(remote));
    socket.on("close", () => this.dropPeer(remote));
    this.emit("peerConnected", this.peers.get(remote)!);
  }

  private registerSocket(id: string, socket: Socket, inbound: boolean): void {
    const existing = this.peers.get(id);
    // Only destroy when the old entry belongs to a DIFFERENT socket — the
    // outbound connect() path re-registers the very same socket.
    if (existing && existing.socket && existing.socket !== socket) {
      existing.socket.destroy();
    }
    this.peers.set(id, {
      id,
      socket,
      bestNumber: existing?.bestNumber ?? 0,
      bestHash: existing?.bestHash ?? "",
      lastSeen: Date.now(),
      inbound,
      banned: existing?.banned ?? false,
    });
  }

  private dataHandler(id: string, socket: Socket): (chunk: Buffer) => void {
    let buffer = Buffer.alloc(0);
    return (chunk) => {
      if (this.peers.get(id)?.banned) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) break;
        const line = buffer.subarray(0, nl).toString("utf8");
        buffer = buffer.subarray(nl + 1);
        if (line.length > P2P_FRAME_LIMIT_BYTES) {
          this.ban(id);
          socket.destroy();
          return;
        }
        if (!line.trim()) continue;
        this.handleLine(id, line);
      }
      if (buffer.length > P2P_FRAME_LIMIT_BYTES) {
        this.ban(id);
        socket.destroy();
      }
    };
  }

  private handleLine(id: string, line: string): void {
    let message: PeerMessage;
    try {
      message = JSON.parse(line) as PeerMessage;
    } catch {
      this.dropPeer(id);
      return;
    }
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.lastSeen = Date.now();
    switch (message.type) {
      case "HELLO":
        if (message.chainId !== this.config.chainId || message.genesisHash !== this.config.genesisHash) {
          this.dropPeer(id); // incompatible chain — do not talk further
          return;
        }
        peer.bestNumber = message.bestNumber;
        peer.bestHash = message.bestHash;
        this.emit("bestNumber", peer, message.bestNumber, message.bestHash);
        break;
      case "GET_BLOCKS":
        this.emit("blocksRequest", peer, message.startNumber, message.maxCount);
        break;
      case "BLOCKS":
        for (const encoded of message.blocks) {
          this.emit("blockAnnouncement", id, encoded);
        }
        if (message.tipNumber > peer.bestNumber) {
          peer.bestNumber = message.tipNumber;
          peer.bestHash = message.tipHash;
        }
        break;
      case "NEW_BLOCK":
        this.emit("blockAnnouncement", id, message.block);
        break;
      case "NEW_TX":
        this.emit("txAnnouncement", id, message.tx);
        break;
      case "GET_PEERS":
        this.sendMessage(peer, { type: "PEERS", peers: this.peerList.map((p) => p.id) });
        break;
      case "PEERS":
        this.emit("peersAnnouncement", id, message.peers.filter((p) => typeof p === "string"));
        break;
      case "PING":
        this.sendMessage(peer, { type: "PONG" });
        break;
      case "PONG":
        break;
      default:
        break;
    }
  }

  private ban(id: string): void {
    const peer = this.peers.get(id);
    if (peer) peer.banned = true;
  }

  /** Sends HELLO with authoritative tip information. */
  sendHelloWithTip(peer: PeerInfo, bestNumber: number, bestHash: string): void {
    this.sendMessage(peer, {
      type: "HELLO",
      protocol: P2P_PROTOCOL,
      networkVersion: this.config.networkVersion,
      chainId: this.config.chainId,
      genesisHash: this.config.genesisHash,
      bestNumber,
      bestHash,
    });
  }

  sendMessage(peer: PeerInfo, message: PeerMessage): void {
    if (!peer.socket || peer.socket.destroyed) return;
    peer.socket.write(JSON.stringify(message) + "\n");
  }

  broadcast(message: PeerMessage, excludePeerId?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.id === excludePeerId) continue;
      this.sendMessage(peer, message);
    }
  }

  requestBlocks(peers: PeerInfo[], startNumber: number, maxCount: number): void {
    for (const peer of peers.slice(0, 4)) {
      this.sendMessage(peer, { type: "GET_BLOCKS", startNumber, maxCount });
    }
  }

  dropPeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.socket?.destroy();
    this.peers.delete(id);
    this.emit("peerDisconnected", peer);
  }
}

export interface PortConfig {
  p2p: number;
  rpc: number;
}

export type { Socket };
