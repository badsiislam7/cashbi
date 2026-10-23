/**
 * Key management for CashBI accounts.
 *
 * Account format follows the EVM model because CashBI is EVM-compatible:
 *   address = last 20 bytes of keccak256(uncompressed pubkey without 0x04 prefix)
 * Keypairs use secp256k1 ECDSA (via the audited @noble/curves library).
 *
 * SECURITY: private keys are only handled in-process and are written to disk
 * only when the operator explicitly runs `cashbi keygen`; the wallet file is
 * created with owner-only permissions (0o600). Keys should never leave the
 * machine unencrypted in production deployments.
 */
import { keccak256 } from "./hash.js";
import { toHex, fromHex, isHex, hexBEToBig } from "../util/bytes.js";
import { secp256k1 } from "@noble/curves/secp256k1";

export interface ECDSASignature {
  /** 32-byte r component (hex). */
  r: string;
  /** 32-byte s component (hex). */
  s: string;
  /** 0..3: y-parity recovery id. */
  recovery: number;
}

export function generatePrivateKey(): Uint8Array {
  return secp256k1.utils.randomPrivateKey();
}

export function privateKeyHex(priv: Uint8Array): string {
  return toHex(priv);
}

export function publicKeyFromPrivate(priv: Uint8Array, compressed = false): Uint8Array {
  return secp256k1.getPublicKey(priv, compressed);
}

export function publicKeyFromHex(pubHex: string): Uint8Array {
  const bytes = fromHex(pubHex); // fromHex accepts an optional 0x prefix
  if (bytes.length !== 33 && bytes.length !== 65) {
    throw new Error("public key must be 33 (compressed) or 65 (uncompressed) bytes");
  }
  return bytes;
}

/** Decompresses a secp256k1 point; returns the 65-byte uncompressed form. */
export function uncompressedPublicKey(pub: Uint8Array): Uint8Array {
  if (pub.length === 65) return pub;
  const point = secp256k1.Point.fromBytes(pub);
  return point.toBytes(false);
}

/** EVM-style 20-byte address derived from an uncompressed public key. */
export function addressFromPublicKey(pub: Uint8Array): string {
  const pre = pub[0] === 0x04 || pub[0] === 0x02 || pub[0] === 0x03 ? pub : uncompressedPublicKey(pub);
  const body = pre.length === 65 ? pre.subarray(1) : pre;
  const digest = keccak256(body);
  return toHex(digest.slice(12));
}

export function addressFromPrivateKey(priv: Uint8Array): string {
  return addressFromPublicKey(publicKeyFromPrivate(priv, false));
}

export function isValidAddress(addr: string): boolean {
  if (!isHex(addr)) return false;
  try {
    return fromHex(addr).length === 20;
  } catch {
    return false;
  }
}

function pad32(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

export function signMessage(messageHash: Uint8Array, priv: Uint8Array): ECDSASignature {
  if (messageHash.length !== 32) throw new Error("message hash must be 32 bytes");
  const sig = secp256k1.sign(messageHash, priv);
  return {
    r: toHex(pad32(u8(sig.r))),
    s: toHex(pad32(u8(sig.s))),
    recovery: sig.recovery,
  };
}

function u8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "bigint") {
    let hex = v.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    return fromHex(hex);
  }
  throw new Error("unexpected signature component type");
}

export function verifySignature(
  messageHash: Uint8Array,
  sig: ECDSASignature,
  expectedPubHex: string,
): boolean {
  try {
    const compact = pad32(fromHex(sig.r));
    const compact2 = pad32(fromHex(sig.s));
    const merged = new Uint8Array(64);
    merged.set(compact, 0);
    merged.set(compact2, 32);
    return secp256k1.verify(merged, messageHash, publicKeyFromHex(expectedPubHex));
  } catch {
    return false;
  }
}

/**
 * Recovers the account address from a message hash plus a recovery-encoded
 * signature (recovery id leads the compact signature, as in @noble/curves).
 */
export function recoverAddress(messageHash: Uint8Array, sig: ECDSASignature): string {
  if (messageHash.length !== 32) throw new Error("message hash must be 32 bytes");
  const compact = pad32(fromHex(sig.r));
  const compact2 = pad32(fromHex(sig.s));
  const sigInstance = new secp256k1.Signature(hexBEToBig(compact), hexBEToBig(compact2)).addRecoveryBit(sig.recovery);
  const point = sigInstance.recoverPublicKey(messageHash);
  const uncompressed = point.toBytes(false);
  return addressFromPublicKey(uncompressed);
}

export interface KeyfileContents {
  address: string;
  privateKey: string;
}

export function makeKeyfile(): KeyfileContents {
  const priv = generatePrivateKey();
  return {
    address: addressFromPrivateKey(priv),
    privateKey: privateKeyHex(priv),
  };
}
