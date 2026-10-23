import { test } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

const CASHBI_ENTRY = join(process.cwd(), "src/cli/index.ts");
const TSX = join(process.cwd(), "node_modules/.bin/tsx");

function rpc(port: number, method: string, params: unknown[] = []): Promise<{ result: unknown; error: unknown }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
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

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startNode(dataDir: string, p2pPort: number, rpcPort: number, extraArgs: string[] = []): ChildProcess {
  const args = [
    TSX,
    CASHBI_ENTRY,
    "start",
    "--data", dataDir,
    "--port", String(p2pPort),
    "--http-port", String(rpcPort),
    "--listen", "127.0.0.1",
    ...extraArgs,
  ];
  return spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function readLogs(proc: ChildProcess): string {
  let out = "";
  proc.stdout.on("data", (d) => { out += d.toString(); });
  proc.stderr.on("data", (d) => { out += d.toString(); });
  return out;
}

async function waitForRpc(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await rpc(port, "net_peerCount", []);
      return;
    } catch {
      await waitFor(500);
    }
  }
  throw new Error(`RPC port ${port} not reachable within ${timeoutMs}ms`);
}

async function waitForTip(port: number, target: number, timeoutMs = 60_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await rpc(port, "bic_getBestBlockNumber", []);
      if (Number(result) >= target) return Number(result);
    } catch {
      // RPC may not be ready yet
    }
    await waitFor(1000);
  }
  throw new Error(`Tip did not reach ${target} within ${timeoutMs}ms`);
}

async function stopNode(proc: ChildProcess): Promise<void> {
  proc.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 5000);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

test("integration: two real nodes sync, propagate tx, mine block, restart recovery", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "cashbi-int-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "cashbi-int-b-"));

  try {
    // Generate wallet for node A (miner)
    const { execSync } = await import("node:child_process");
    const keygenOut = execSync(
      `node --import tsx ${CASHBI_ENTRY} keygen --data ${dirA}`,
      { encoding: "utf8", timeout: 30_000 },
    );
    const addressMatch = keygenOut.match(/address: (0x[0-9a-f]+)/);
    assert.ok(addressMatch, "keygen should output an address");
    const minerAddr = addressMatch[1];

    // Start node A (miner)
    const nodeA = startNode(dirA, 30401, 8561, ["--coinbase", minerAddr, "--allow-mining", "--mining-rate", "1024"]);
    readLogs(nodeA);
    await waitForRpc(8561);

    // Start node B (connects to A)
    const nodeB = startNode(dirB, 30402, 8562, ["--peers", "127.0.0.1:30401"]);
    readLogs(nodeB);
    await waitForRpc(8562);

    // Step 3: Same chain ID and genesis hash
    const [chainIdA, genesisA] = await Promise.all([
      rpc(8561, "eth_chainId", []),
      rpc(8561, "bic_getBestBlockHash", []),
    ]);
    const [chainIdB, genesisB] = await Promise.all([
      rpc(8562, "eth_chainId", []),
      rpc(8562, "bic_getBestBlockHash", []),
    ]);
    assert.equal(chainIdB.result, chainIdA.result, "chain IDs must match");
    assert.equal(genesisB.result, genesisA.result, "genesis hashes must match");

    // Step 4: P2P connection
    const peerCountA = await rpc(8561, "net_peerCount", []);
    const peerCountB = await rpc(8562, "net_peerCount", []);
    assert.equal(peerCountA.result, 1, "node A should have 1 peer");
    assert.equal(peerCountB.result, 1, "node B should have 1 peer");

    // Wait for node B to sync to node A's tip
    const tipA = await rpc(8561, "bic_getBestBlockNumber", []);
    await waitForTip(8562, Number(tipA.result));
    const tipB = await rpc(8562, "bic_getBestBlockNumber", []);
    assert.equal(Number(tipB.result), Number(tipA.result), "node B must sync to node A's tip");

    // Step 5: Submit a signed transaction to node A
    const { signTransaction, encodeSignedTransaction, randomAccount, txHash } = await import("../src/tx/transaction.js");
    const { fromHex, toHex } = await import("../src/util/bytes.js");

    // Read node A's private key from wallet.json
    const { readFileSync } = await import("node:fs");
    const wallet = JSON.parse(readFileSync(join(dirA, "wallet.json"), "utf8")) as { privateKey: string };
    const privKey = fromHex(wallet.privateKey);
    const recipient = randomAccount();

    const tx = signTransaction(
      { nonce: 0n, to: recipient.address, value: 100000000000000000n, data: new Uint8Array(0), gasPrice: 1n, gas: 21000n, chainId: 901291 },
      privKey,
    );
    const raw = toHex(encodeSignedTransaction(tx));
    const txHashHex = txHash(tx);

    const submitResult = await rpc(8561, "bic_sendRawTransaction", [raw]);
    assert.equal(submitResult.error, undefined, "tx submission should succeed");
    assert.equal(submitResult.result, txHashHex, "returned hash should match");

    // Step 6: Wait for node A to mine a block and both nodes to converge
    const preTip = Number((await rpc(8561, "bic_getBestBlockNumber", [])).result);
    await waitForTip(8561, preTip + 1);
    const postTipA = await rpc(8561, "bic_getBestBlockNumber", []);
    const postTipB = await rpc(8562, "bic_getBestBlockNumber", []);
    assert.equal(Number(postTipB.result), Number(postTipA.result), "both nodes must converge on same tip");

    const hashA = await rpc(8561, "bic_getBestBlockHash", []);
    const hashB = await rpc(8562, "bic_getBestBlockHash", []);
    assert.equal(hashB.result, hashA.result, "both nodes must have same best block hash");

    // Verify recipient balance on both nodes
    const balA = await rpc(8561, "bic_getBalance", [recipient.address]);
    const balB = await rpc(8562, "bic_getBalance", [recipient.address]);
    assert.equal(balB.result, balA.result, "recipient balance must match on both nodes");

    // Step 7: Stop node B, restart, verify recovery
    await stopNode(nodeB);
    await waitFor(2000);

    const nodeB2 = startNode(dirB, 30402, 8562, ["--peers", "127.0.0.1:30401"]);
    readLogs(nodeB2);
    await waitForRpc(8562);

    // Node B should recover its tip from the ledger
    const recoveredTip = await rpc(8562, "bic_getBestBlockNumber", []);
    assert.ok(Number(recoveredTip.result) > 0, "node B should recover a non-zero tip from ledger");

    // Node B should reconnect to node A
    const peerCountB2 = await rpc(8562, "net_peerCount", []);
    assert.equal(peerCountB2.result, 1, "node B should reconnect to node A");

    // Wait for node B to sync again (node A keeps mining, so check >=)
    await waitForTip(8562, Number(postTipA.result));
    const tipB2 = await rpc(8562, "bic_getBestBlockNumber", []);
    assert.ok(Number(tipB2.result) >= Number(postTipA.result), "node B must re-sync to at least node A's pre-restart tip");

    // Step 8: Test mismatched genesis rejection
    const { execSync: _execSync2 } = await import("node:child_process");
    const dirC = mkdtempSync(join(tmpdir(), "cashbi-int-c-"));
    try {
      // Copy node A's data to C, then corrupt genesis.json
      execSync(`cp -r ${dirA}/. ${dirC}/`);
      const { writeFileSync } = await import("node:fs");
      const genesisPath = join(dirC, "genesis.json");
      const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
      genesis.genesisHash = "0x" + "11".repeat(32);
      writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

      const procC = spawn("node", [TSX, CASHBI_ENTRY, "start", "--data", dirC, "--port", "30403", "--http-port", "8563", "--listen", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
      let exitCode = -1;
      await new Promise((resolve) => {
        procC.on("exit", (code) => { exitCode = code ?? -1; resolve(undefined); });
        procC.stderr.on("data", () => {}); // consume
        procC.stdout.on("data", () => {}); // consume
        setTimeout(() => { if (exitCode === -1) { procC.kill(); resolve(undefined); } }, 5000);
      });
      assert.equal(exitCode, 1, "mismatched genesis should cause exit code 1");
    } finally {
      rmSync(dirC, { recursive: true, force: true });
      // Always stop child processes, even if an assertion failed earlier.
      await stopNode(nodeB2).catch(() => {});
      await stopNode(nodeA).catch(() => {});
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
