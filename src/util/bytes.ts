/**
 * Byte and hex utility helpers used across the CashBI reference implementation.
 * All hex strings use the `0x`-prefixed lowercase form.
 */
export type Bytes = Uint8Array;

export function toHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  const h = stripZeroHex(hex);
  if (h.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  if (!/^[0-9a-f]*$/.test(h)) throw new Error(`invalid hex: ${hex}`);
  const buf = Buffer.from(h, "hex");
  return buf.length === 0 ? new Uint8Array(0) : new Uint8Array(buf);
}

export function isHex(hex: string): boolean {
  return typeof hex === "string" && /^0x[0-9a-f]*$/.test(hex.toLowerCase());
}

export function stripZeroHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Left-pads `value` to `size` unsigned 256-bit big-endian bytes. */
export function padLeft(bytes: Uint8Array, size: number): Uint8Array {
  if (bytes.length > size) throw new Error("value exceeds word size");
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
}

export function bigToHexBE(value: bigint, size = 32): Uint8Array {
  if (value < 0n) throw new Error("negative value not allowed");
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const bytes = fromHex(hex);
  return padLeft(bytes, size);
}

export function hexBEToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

/** utf8 helpers used for misc encoded payloads */
export function utf8ToBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
