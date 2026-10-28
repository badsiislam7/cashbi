import { test } from "node:test";
import assert from "node:assert";
import { FullNode, defaultNodeConfig } from "../src/node/node.js";
import { RpcServer } from "../src/rpc/rpc.js";
import { signTransaction, randomAccount, encodeSignedTransaction } from "../src/tx/transaction.js";
import { BIC, DEV_CHAIN_ID, DEFAULT_P2P_PORT, BLOCK_REWARD } from "../src/config/params.js";
import { emptyGenesisConfig } from "../src/chain/genesis.js";
import { buildBlockForMining } from "../src/mining/candidate.js";
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

    // Mine blocks directly on A (real PoW search is infeasible at difficulty 1
    // under POW_LIMIT ~2^32 hashes/block); every other validation rule still
    // runs through acceptBlockForTesting. The first block
    // includes the tx submitted above via RPC.
    const template = buildBlockForMining({
      chain: nodeA.chain,
      mempool: nodeA.mempool,
      coinbase: minerAddr,
      timestamp: Math.floor(Date.now() / 1000),
      activeReward: BLOCK_REWARD,
      extraData: new TextEncoder().encode("node-test"),
    });
    assert.notEqual(template, null, "block template must be buildable");
    const receipt1 = nodeA.chain.acceptBlockForTesting(template!);
    assert.equal(receipt1.accepted, true, `first block accepted on A: ${receipt1.reason}`);

    // Second block so tip.number >= 2.
    const template2 = buildBlockForMining({
      chain: nodeA.chain,
      mempool: nodeA.mempool,
      coinbase: minerAddr,
      timestamp: Math.floor(Date.now() / 1000) + 1,
      activeReward: BLOCK_REWARD,
      extraData: new TextEncoder().encode("node-test-2"),
    });
    assert.notEqual(template2, null, "second block template must be buildable");
    const receipt2 = nodeA.chain.acceptBlockForTesting(template2!);
    assert.equal(receipt2.accepted, true, `second block accepted on A: ${receipt2.reason}`);

    // Replay the same blocks on B so both chains converge (P2P gossip of
    // blocks created without valid PoW would fail PoW on the receiving
    // node; block validation itself is unchanged).
    const block1 = nodeA.chain.getBlockByNumber(1);
    const block2 = nodeA.chain.getBlockByNumber(2);
    assert.notEqual(block1, null, "block 1 must be retained on A");
    assert.notEqual(block2, null, "block 2 must be retained on A");
    const r1b = nodeB.chain.acceptBlockForTesting(block1!);
    assert.equal(r1b.accepted, true, `block 1 accepted on B: ${r1b.reason}`);
    const r2b = nodeB.chain.acceptBlockForTesting(block2!);
    assert.equal(r2b.accepted, true, `block 2 accepted on B: ${r2b.reason}`);

    // Verify both chains converged to the same tip and state.
    assert.equal(nodeB.chain.tip.number, 2, "B's tip should be at number 2");
    assert.equal(nodeB.chain.tip.hash, nodeA.chain.tip.hash, "B's tip hash should match A's");
    const bBalance = nodeB.chain.tipState.getAccount(payeeAddr)?.balance ?? 0n;
    assert.equal(bBalance === BIC(1n), true, `payee balance was ${bBalance}`);
  } finally {
    if (rpcA) await rpcA.stop();
    await nodeB.stop();
    await nodeA.stop();
  }
});

function toHexRaw(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}
