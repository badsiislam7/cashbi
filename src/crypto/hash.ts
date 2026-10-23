/**
 * Cryptographic hash helpers. Keccak-256 is the canonical hash of the CashBI
 * state model (chosen for EVM compatibility); SHA-256 is used for secondary
 * integrity checks such as persisted data snapshots.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { toHex, utf8ToBytes, type Bytes } from "../util/bytes.js";

/** Keccak-256 (not NIST SHA3-256) to match the EVM precompile `SHA3`. */
export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function keccak256Hex(data: Uint8Array): string {
  return toHex(keccak_256(data));
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function keccakUtf8(text: string): Uint8Array {
  return keccak_256(utf8ToBytes(text));
}

export function hashBytes(...chunks: Bytes[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return keccak_256(all);
}

export function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}
