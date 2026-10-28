import { test } from "node:test";
import assert from "node:assert";
import { P2PServer } from "../src/net/server.js";
import { makeDeferred } from "../src/util/async.js";

/**
 * Handshake compatibility tests: a peer announcing DIFFERENT consensus
 * parameters in HELLO must be dropped, so nodes with incompatible consensus
 * parameter sets never share a chain. paramVersion is mandatory: peers that
 * omit the field, send a non-string value, or send a mismatching string are
 * all dropped. The genesis hash alone does not change when consensus
 * parameters change (they are not encoded in the genesis header), so version
 * enforcement is the only wire-level protection against silent rule mixing.
 */

const HOST = "127.0.0.1";
const PORT_SERVER = 37871; // unique to this suite
const GENESIS = "0x" + "aa".repeat(32);

function configFor(paramVersion: string) {
  return {
    chainId: 901291,
    genesisHash: GENESIS,
    paramVersion,
    networkVersion: 1,
  };
}

async function settle(ms: number): Promise<"settled"> {
  return new Promise((resolve) => setTimeout(() => resolve("settled"), ms));
}

test("handshake: HELLO announcing a DIFFERENT paramVersion is dropped (no silent consensus mixing)", async () => {
  const server = new P2PServer(configFor("param-alice"));
  await server.listen(PORT_SERVER, HOST);
  const dropped = makeDeferred<string>();
  server.on("peerDisconnected", (peer) => dropped.resolve(peer.id));

  const client = new P2PServer(configFor("param-bob")); // differs ONLY in paramVersion
  const peer = client.connect(HOST, PORT_SERVER);
  assert.notEqual(peer, null, "TCP connect succeeds (drop happens at the protocol layer)");
  client.sendHelloWithTip(peer!, 0, "0x" + "bb".repeat(32));

  const droppedId = await dropped.promise;
  assert.equal(droppedId.startsWith(HOST), true, "incompatible peer was dropped");
  assert.equal(server.peerCount(), 0, "no state is retained for the dropped peer");
  await server.close();
  await client.close();
});

test("handshake: HELLO with matching parameters stays connected (same-version nodes are compatible)", async () => {
  const server = new P2PServer(configFor("param-alice"));
  await server.listen(PORT_SERVER, HOST);
  let disconnected = false;
  server.on("peerDisconnected", () => {
    disconnected = true;
  });

  const client = new P2PServer(configFor("param-alice"));
  const peer = client.connect(HOST, PORT_SERVER);
  assert.notEqual(peer, null);
  client.sendHelloWithTip(peer!, 5, "0x" + "cc".repeat(32));

  await Promise.race([settle(200)]);
  assert.equal(disconnected, false, "matching handshake must not drop the peer");
  assert.equal(server.peerCount(), 1, "peer remains registered");
  assert.equal(server.bestNumberSeen(), 5, "tip info from the compatible peer is retained");
  await server.close();
  await client.close();
});

test("handshake: HELLO without a paramVersion field is rejected (field is mandatory)", async () => {
  const server = new P2PServer(configFor("param-alice"));
  await server.listen(PORT_SERVER, HOST);
  let disconnected = false;
  server.on("peerDisconnected", () => {
    disconnected = true;
  });

  const client = new P2PServer(configFor("param-alice"));
  const peer = client.connect(HOST, PORT_SERVER);
  assert.notEqual(peer, null);
  client.sendMessage(peer!, {
    type: "HELLO",
    protocol: "cashbi/0.1",
    networkVersion: 1,
    chainId: 901291,
    genesisHash: GENESIS,
    bestNumber: 0,
    bestHash: "0x" + "dd".repeat(32),
    // paramVersion deliberately omitted
  });

  await settle(150);
  assert.equal(disconnected, true, "peer omitting mandatory paramVersion must be dropped");
  assert.equal(server.peerCount(), 0, "no state is retained for the dropped peer");
  await server.close();
  await client.close();
});

test("handshake: HELLO with an empty string paramVersion is rejected", async () => {
  const server = new P2PServer(configFor("param-alice"));
  await server.listen(PORT_SERVER, HOST);
  const dropped = makeDeferred<string>();
  server.on("peerDisconnected", (peer) => dropped.resolve(peer.id));

  const client = new P2PServer(configFor("param-alice"));
  const peer = client.connect(HOST, PORT_SERVER);
  assert.notEqual(peer, null);
  client.sendMessage(peer!, {
    type: "HELLO",
    protocol: "cashbi/0.1",
    networkVersion: 1,
    paramVersion: "", // malformed: empty string
    chainId: 901291,
    genesisHash: GENESIS,
    bestNumber: 0,
    bestHash: "0x" + "ee".repeat(32),
  });

  const droppedId = await dropped.promise;
  assert.equal(droppedId.startsWith(HOST), true, "peer with empty paramVersion must be dropped");
  assert.equal(server.peerCount(), 0, "no state is retained for the dropped peer");
  await server.close();
  await client.close();
});

test("handshake: mismatched chainId or genesisHash is still dropped (pre-existing behavior)", async () => {
  for (const mutate of [
    { chainId: 999999 },
    { genesisHash: "0x" + "ff".repeat(32) },
  ] as Array<Partial<ReturnType<typeof configFor>>>) {
    const server = new P2PServer(configFor("param-alice"));
    await server.listen(PORT_SERVER, HOST);
    const dropped = makeDeferred<string>();
    server.on("peerDisconnected", (peer) => dropped.resolve(peer.id));

    const client = new P2PServer({ ...configFor("param-alice"), ...mutate });
    const peer = client.connect(HOST, PORT_SERVER);
    assert.notEqual(peer, null);
    client.sendHelloWithTip(peer!, 0, "0x" + "ee".repeat(32));
    const id = await dropped.promise;
    assert.equal(id.startsWith(HOST), true);
    assert.equal(server.peerCount(), 0);
    await server.close();
    await client.close();
  }
});
