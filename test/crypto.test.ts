import { test } from "node:test";
import assert from "node:assert";
import { keccak256Hex, sha256 } from "../src/crypto/hash.js";
import {
  generatePrivateKey,
  publicKeyFromPrivate,
  addressFromPrivateKey,
  addressFromPublicKey,
  recoverAddress,
  signMessage,
  verifySignature,
  isValidAddress,
  uncompressedPublicKey,
} from "../src/crypto/keys.js";
import { fromHex, toHex } from "../src/util/bytes.js";

test("keccak: standard vectors", () => {
  // Canonical keccak256("") constant
  assert.equal(keccak256Hex(new Uint8Array(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  // keccak256("abc")
  const abc = new TextEncoder().encode("abc");
  assert.equal(keccak256Hex(abc), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // NIST sha256("abc")
  assert.equal(Buffer.from(sha256(abc)).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("keys: address derivation is stable and 20 bytes", () => {
  const priv = generatePrivateKey();
  const address = addressFromPrivateKey(priv);
  assert.equal(isValidAddress(address), true);
  assert.equal(address, address.toLowerCase());
  const pub = publicKeyFromPrivate(priv, false);
  assert.equal(addressFromPublicKey(pub), address);
  const compact = publicKeyFromPrivate(priv, true);
  assert.equal(addressFromPublicKey(uncompressedPublicKey(compact)), address);
});

test("keys: sign / verify / recover roundtrip", () => {
  const priv = generatePrivateKey();
  const expectedAddress = addressFromPrivateKey(priv);
  const msg = new Uint8Array(32);
  for (let i = 0; i < 32; i++) msg[i] = (i * 7 + 1) % 256;
  const sig = signMessage(msg, priv);
  assert.equal(sig.recovery === 0 || sig.recovery === 1, true);
  const pubHex = toHex(publicKeyFromPrivate(priv, false));
  assert.equal(verifySignature(msg, sig, pubHex), true);
  // recover
  const recovered = recoverAddress(msg, sig);
  assert.equal(recovered, expectedAddress);
  // tampering breaks verify
  const badMsg = new Uint8Array(32);
  badMsg[0] = 1;
  assert.equal(verifySignature(badMsg, sig, pubHex), false);
  // tampered message recovers a DIFFERENT address (no throw required)
  const other = recoverAddress(badMsg, sig);
  assert.notEqual(other, expectedAddress);
});

test("keys: deterministic known keypair (d=1)", () => {
  // Private key d=1 is a valid secp256k1 key.
  const priv = new Uint8Array(32);
  priv[31] = 1;
  const pub = publicKeyFromPrivate(priv, false);
  assert.equal(pub[0], 0x04);
  const address = addressFromPublicKey(pub);
  assert.equal(isValidAddress(address), true);
});

test("keys: address validation strictness", () => {
  assert.equal(isValidAddress("0x" + "11".repeat(20)), true);
  assert.equal(isValidAddress("0x" + "11".repeat(19)), false);
  assert.equal(isValidAddress("双十一"), false);
  // Odd-length hex address should be invalid (fromHex no longer silently pads)
  assert.equal(isValidAddress("0x" + "11".repeat(19) + "1"), false);
  void fromHex;
});

test("util: fromHex rejects odd-length hex instead of silently padding", () => {
  assert.throws(() => fromHex("0x1"), /odd-length/);
  assert.throws(() => fromHex("0xabc"), /odd-length/);
  assert.throws(() => fromHex("1"), /odd-length/);
  // Even-length hex still works
  assert.equal(fromHex("0x00").length, 1);
  assert.equal(fromHex("0x0001").length, 2);
});
