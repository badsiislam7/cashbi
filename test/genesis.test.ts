import { test } from "node:test";
import assert from "node:assert";
import { buildGenesis, emptyGenesisConfig, genesisBlockHash, genesisManifest } from "../src/chain/genesis.js";

/**
 * Genesis compatibility pins for the consensus redesign.
 *
 * The approved target parameters (16M supply, SHA-256 PoW, 600 s blocks,
 * 1536-block retargets) do NOT change the genesis block: retarget interval,
 * target block time, PoW hash algorithm, and the supply cap are not encoded
 * in the genesis header. What enters the genesis hash is ONLY the genesis
 * header (rlp(blockHash) — parentHash, number, timestamp, difficulty,
 * coinbase, extraData, gas fields, transactionsRoot, stateRoot, nonce) with
 * the allocation-derived stateRoot. These tests pin that fact so any
 * accidental genesis-affecting change fails loudly BEFORE migration work.
 */

test("genesis: the dev manifest and hash are unchanged by the consensus redesign", () => {
  const manifest = genesisManifest(emptyGenesisConfig(0));
  assert.deepEqual(manifest, {
    paramVersion: "0.0.1-dev",
    chainId: 901291,
    genesisHash: "0x88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b",
    genesisTimestamp: 0,
    allocationCount: 0,
  });
});

test("genesis: hash derivation is deterministic (every node re-derives the same identity)", () => {
  const a = genesisBlockHash(emptyGenesisConfig(0));
  const b = genesisBlockHash(emptyGenesisConfig(0));
  assert.equal(a, b);
  assert.equal(a, "0x88b258e965edb0a7b45e43ce45b5f39f58a85a20ae41f63bd8672b726eb9824b");
});

test("genesis: header fields that the redesign intentionally leaves untouched", () => {
  const { block, state } = buildGenesis(emptyGenesisConfig(0));
  // Initial mining difficulty 1.0 (the approved initial difficulty):
  assert.equal(block.header.difficulty, 1n);
  assert.equal(block.header.timestamp, 0);
  assert.equal(block.header.number, 0);
  assert.equal(block.header.nonce, 0n);
  // The stored stateRoot matches the (empty) allocation set's state:
  assert.equal(state.stateRoot(), block.header.stateRoot);
  // paramVersion travels in the MANIFEST (and future handshake enforcement),
  // never inside the header — a later version bump cannot silently alter the
  // genesis hash either; manifest equality is what flags configuration drift.
  assert.equal(genesisManifest(emptyGenesisConfig(0)).paramVersion, "0.0.1-dev");
});
