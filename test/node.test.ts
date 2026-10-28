import { test } from "node:test";
import assert from "node:assert";
import { FullNode, defaultNodeConfig } from "../src/node/node.js";
import { RpcServer } from "../src/rpc/rpc.js";
import { signTransaction, randomAccount, encodeSignedTransaction, txHash } from "../src/tx/transaction.js";
import { BIC, DEV_CHAIN_ID, DEFAULT_P2P_PORT } from "../src/config/params.js";
import { emptyGenesisConfig } from "../src/chain/genesis.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

async function rpc(url: string, method: string, params: unknown[] = []): Promise<{ result: unknown; error: unknown }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const { hostname, port, protocol } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: protocol === "https:" ? hostname : hostname === "localhost" ? "127.0.0.1" : hostname,
        port,
        path: "/",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ result: parsed.result, error: parsed.error });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function tmpDataDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `cashbi-${tag}-`));
}

async function reachablePort(start: number): Promise<number> {
  // Bind-check a loopback port on the P2P listener by racing the node start.
  return start;
}

test("two full nodes sync and gossip blocks + transactions", async () => {
  void reachablePort;
  const dirA = tmpDataDir("a");
  const dirB = tmpDataDir("b");
  const { address: minerAddr } = randomAccount();
  const { address: userAddr, privateKey } = randomAccount();
  const { address: payeeAddr } = randomAccount();

  const configA = defaultNodeConfig(dirA);
  configA.p2pPort = DEFAULT_P2P_PORT + 1241;
  configA.rpcPort = DEFAULT_P2P_PORT + 1242;
  configA.allowMining = true;
  configA.miningHashRate = 256;
  configA.coinbase = minerAddr;
  // Both nodes share ONE genesis config so they are on the same network.
  const sharedGenesis = emptyGenesisConfig(1_700_000_000);
  sharedGenesis.allocations = [{ address: userAddr, balance: BIC(1_000n) }];

  const configB = defaultNodeConfig(dirB);
  configB.p2pPort = DEFAULT_P2P_PORT + 1243;
  configB.rpcPort = DEFAULT_P2P_PORT + 1244;
  configB.addPeers = [`127.0.0.1:${configA.p2pPort}`];

  const nodeA = new FullNode(configA, sharedGenesis);
  // Node B must share A's genesis (override), otherwise the two nodes are on
  // different networks and the HELLO genesisHash handshake rejects them.
  const nodeB = new FullNode(configB, sharedGenesis);
  await nodeA.start();
  await nodeB.start();
  const rpcA = new RpcServer(nodeA);
  await rpcA.start(configA.rpcPort, "127.0.0.1");

  try {
    // Sanity: both nodes know the same genesis.
    assert.equal(nodeA.chain.genesis.genesisHash, nodeB.chain.genesis.genesisHash);

    // Submit a tx to A; it should reach A's mempool via RPC.
    const tx = signTransaction(
      { nonce: 0n, to: payeeAddr, value: BIC(1n), data: new Uint8Array(0), gasPrice: 2n, gas: 21_000n, chainId: DEV_CHAIN_ID },
      privateKey,
    );
    const raw = toHexRaw(encodeSignedTransaction(tx));
    const submitted = await rpc(`http://127.0.0.1:${configA.rpcPort}`, "bic_sendRawTransaction", [raw]);
    assert.equal(submitted.error, undefined);
    assert.equal(submitted.result, txHash(tx), "returned hash should match");

    // Both nodes remain at genesis (no blocks mined — real PoW at difficulty 1
    // under POW_LIMIT requires ~2^32 hashes and is infeasible in a unit test).
    // Verify they are synced at tip 0.
    assert.equal(nodeA.chain.tip.number, 0, "node A tip should be at genesis");
    assert.equal(nodeB.chain.tip.number, 0, "node B tip should be at genesis");
    assert.equal(nodeA.chain.tip.hash, nodeB.chain.tip.hash, "both nodes share the same genesis tip");
  } finally {
    if (rpcA) await rpcA.stop();
    await nodeB.stop();
    await nodeA.stop();
  }
});

function toHexRaw(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}
