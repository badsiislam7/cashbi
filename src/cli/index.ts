#!/usr/bin/env node
/**
 * CashBI command-line interface.
 *
 * Commands:
 *   cashbi keygen [--data DIR]            create a dev wallet (owner-only file)
 *   cashbi start   [options]              run a full node (mining opt-in only)
 *   cashbi help                            usage
 *
 * Mining consent: real CPU PoW consumes compute, so mining starts ONLY when
 *  - the operator passes --allow-mining, or
 *  - an interactive prompt is answered with a literal YES.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit, argv } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FullNode, defaultNodeConfig } from "../node/node.js";
import { RpcServer } from "../rpc/rpc.js";
import { makeKeyfile, isValidAddress, type KeyfileContents } from "../crypto/keys.js";
import { DEFAULT_P2P_PORT, DEFAULT_RPC_PORT, DEV_MINING_HASH_RATE, DEV_CHAIN_ID } from "../config/params.js";

const USAGE = `CashBI — devnet full node for the CashBI Layer 1 (native coin: BIC)

Usage:
  cashbi keygen [--data <dir>]
  cashbi start [--data <dir>] [--port <n>] [--http-port <n>] [--listen <addr>]
               [--peers <host:port,host:port>] [--dns-seed <host> ...]
               [--discovery-url <url> ...] [--coinbase <addr>]
               [--allow-mining] [--mining-rate <n>] [--no-rpc]
  cashbi help

Notes:
  * Mining is REAL Proof-of-Work and only starts with explicit consent
    (--allow-mining or answering YES at the prompt).
  * All peer discovery is operator-configured or runtime-fed: this build
    deliberately contains no hardcoded peer IP addresses.
  * This is a development build; it is NOT production-ready (docs/SECURITY.md).
`;

interface StartOptions {
  dataDir: string;
  p2pPort: number;
  httpPort: number;
  listen: string;
  peers: string[];
  dnsSeeds: string[];
  discoveryUrls: string[];
  coinbase: string | null;
  allowMining: boolean;
  miningRate: number;
  rpcEnabled: boolean;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    stdout.write(USAGE);
    exit(0);
  }
  const command = args[0];
  const rest = args.slice(1);
  if (command === "keygen") await commandKeygen(rest);
  else if (command === "start") await commandStart(rest);
  else {
    stdout.write(`unknown command: ${command}\n\n`);
    stdout.write(USAGE);
    exit(2);
  }
}

async function parseValue(rest: string[], names: string[]): Promise<string | undefined> {
  const normalized = rest.filter(Boolean);
  for (let i = 0; i < normalized.length; i++) {
    if (names.includes(normalized[i])) {
      const value = normalized[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${normalized[i]}`);
      return value;
    }
  }
  return undefined;
}

async function commandKeygen(rest: string[]): Promise<void> {
  const dataDir = resolve((await parseValue(rest, ["--data"])) ?? ".");
  const walletPath = `${dataDir}/wallet.json`;
  if (existsSync(walletPath)) {
    const existing = JSON.parse(readFileSync(walletPath, "utf8")) as KeyfileContents;
    stdout.write(`wallet already exists: ${existing.address}\n(written at ${walletPath})\n`);
    return;
  }
  const keyfile = makeKeyfile();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(walletPath, JSON.stringify(keyfile, null, 2), { mode: 0o600 });
  stdout.write(`address: ${keyfile.address}\nprivate key: 0x${keyfile.privateKey.replace(/^0x/, "")}\n`);
  stdout.write(`written to ${walletPath} (owner-only permissions) — keep it safe\n`);
}

/** Options parser for `start` — explicit, typed, keeps argv order-insensitive. */
async function parseStartOptions(rest: string[]): Promise<StartOptions> {
  const parsed = (await import("node:util")).parseArgs({
    args: rest,
    options: {
      data: { type: "string", short: "d" },
      port: { type: "string", short: "p" },
      "http-port": { type: "string" },
      listen: { type: "string" },
      peers: { type: "string" },
      "dns-seed": { type: "string", multiple: true },
      "discovery-url": { type: "string", multiple: true },
      coinbase: { type: "string" },
      "allow-mining": { type: "boolean", default: false },
      "mining-rate": { type: "string" },
      "no-rpc": { type: "boolean", default: false },
      "chain-id": { type: "string" },
    },
    strict: false,
  }) as unknown as Record<string, string | string[] | boolean | undefined>;

  const dataDir = resolve((parsed["data"] as string) ?? ".");
  const peers = splitList(parsed["peers"] as string | undefined);
  const dnsSeeds = [...((parsed["dns-seed"] as string[]) ?? [])];
  const discoveryUrls = [...((parsed["discovery-url"] as string[]) ?? [])];
  const coinbaseRaw = (parsed["coinbase"] as string | undefined) ?? null;
  const coinbase = coinbaseRaw && coinbaseRaw !== "" ? coinbaseRaw.toLowerCase() : null;
  if (coinbase && !isValidAddress(coinbase)) throw new Error(`invalid coinbase address: ${coinbase}`);
  const miningRateRaw = Number((parsed["mining-rate"] as string | undefined) ?? DEV_MINING_HASH_RATE);
  if (!Number.isFinite(miningRateRaw) || miningRateRaw < 0) throw new Error("invalid --mining-rate");
  return {
    dataDir,
    p2pPort: Number((parsed["port"] as string | undefined) ?? DEFAULT_P2P_PORT),
    httpPort: Number((parsed["http-port"] as string | undefined) ?? DEFAULT_RPC_PORT),
    listen: (parsed["listen"] as string | undefined) ?? "127.0.0.1",
    peers,
    dnsSeeds,
    discoveryUrls,
    coinbase,
    allowMining: Boolean(parsed["allow-mining"]),
    miningRate: Math.floor(miningRateRaw),
    rpcEnabled: !parsed["no-rpc"],
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

async function commandStart(rest: string[]): Promise<void> {
  const opts = await parseStartOptions(rest);
  const chainIdEnv = DEV_CHAIN_ID;

  // Well-defined consent flow, in priority order:
  //   1. explicit --allow-mining flag (recorded as granted from the CLI)
  //   2. interactive typed YES confirmation (TTY only)
  //   3. absence of both → mining stays disabled.
  let miningConsent = opts.allowMining;
  if (!miningConsent && stdin.isTTY) {
    miningConsent = await promptMiningConsent();
    if (miningConsent) stdout.write(`  mining consent recorded from interactive prompt\n`);
  }
  if (!miningConsent) {
    stdout.write(`  mining: disabled (no consent; pass --allow-mining to enable)\n`);
  }

  const nodeConfig = defaultNodeConfig(opts.dataDir);
  nodeConfig.p2pPort = opts.p2pPort;
  nodeConfig.p2pHost = opts.listen;
  nodeConfig.rpcEnabled = opts.rpcEnabled;
  nodeConfig.rpcPort = opts.httpPort;
  nodeConfig.addPeers = opts.peers;
  nodeConfig.dnsSeeds = opts.dnsSeeds;
  nodeConfig.discoveryUrls = opts.discoveryUrls;
  nodeConfig.coinbase = opts.coinbase;
  nodeConfig.miningHashRate = opts.miningRate;
  nodeConfig.allowMining = miningConsent;

  let node: FullNode;
  try {
    node = new FullNode(nodeConfig);
  } catch (err) {
    stdout.write(`node init failed: ${(err as Error).message}\n`);
    exit(1);
    return;
  }
  await node.start();
  stdout.write(
    `cashbi node started: chainId=${chainIdEnv} genesis=${node.chain.genesis.genesisHash} ` +
    `tip=${node.chain.tip.number}\n` +
    `  p2p: listening on ${opts.listen}:${opts.p2pPort}\n`,
  );
  let rpc: RpcServer | null = null;
  if (opts.rpcEnabled) {
    rpc = new RpcServer(node);
    await rpc.start(opts.httpPort, "127.0.0.1");
    stdout.write(`  rpc: http://127.0.0.1:${opts.httpPort}\n`);
  } else {
    stdout.write(`  rpc: disabled\n`);
  }
  if (node.miner?.status().mining) {
    stdout.write(`  mining: consented CPU PoW at ${opts.miningRate} keccak/s\n`);
  } else if (miningConsent) {
    stdout.write(`  mining: consent present but miner not running (coinbase available? run cashbi keygen)\n`);
  }
  // keepAlive wiring (no polling loop; event-driven shutdown)

  const keepAlive = async (signal: string) => {
    stdout.write(`\n${signal} — shutting down…\n`);
    if (rpc) await rpc.stop();
    await node.stop();
    exit(0);
  };
  processOn("SIGINT", () => void keepAlive("SIGINT"));
  processOn("SIGTERM", () => void keepAlive("SIGTERM"));

  // Status ticker so operators see the chain move.
  const ticker = setInterval(() => {
    const tipInfo = node.chain.tip;
    const peers = node.peerCount();
    const mempool = node.mempool.stats().size;
    const miner = node.minerStatus();
    stdout.write(
      `[tip=${tipInfo.number} peers=${peers} mempool=${mempool}` +
      `${miner?.mining ? ` mining(hashes=${miner.hashesTried})` : ""}]\n`,
    );
  }, 15_000);
  ticker.unref();
}

function processOn(signal: string, handler: () => void): void {
  process.on(signal as NodeJS.Signals, handler);
}

/** Interactive mine-consent prompt with a strict literal reply. */
async function promptMiningConsent(): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(
      "Enable REAL CPU mining (consumes compute)? Type YES to accept: ",
    )).trim();
    return answer === "YES";
  } finally {
    rl.close();
  }
}

// Only auto-run when executed directly (tests import functions selectively).
const invokedDirectly = argv[1] && argv[1].includes("cli");
if (invokedDirectly) {
  void main(argv.slice(2)).catch((err) => {
    stdout.write(`error: ${(err as Error).message}\n`);
    exit(1);
  });
}

export { main as cliMain, parseStartOptions, promptMiningConsent, commandStart };
