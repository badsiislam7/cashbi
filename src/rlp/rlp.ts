/**
 * Minimal RLP (Recursive Length Prefix) encoding used for transaction and
 * block serialization. Implements the Ethereum RLP specification subset:
 * byte strings and nested lists of byte strings (no arbitrary-length encoders
 * beyond what ethers-style users require).
 */
import { utf8ToBytes, bytesToUtf8 } from "../util/bytes.js";

export type RLPItem = Uint8Array | RLPItem[];

export function encode(input: RLPItem): Uint8Array {
  if (input instanceof Uint8Array) return encodeString(input);
  return encodeList(input);
}

function encodeString(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] < 0x80) {
    return new Uint8Array(data);
  }
  if (data.length <= 55) {
    return prefix(0x80 + data.length, data);
  }
  const lenBytes = minimalBytes(BigInt(data.length));
  return prefix(0xb7 + lenBytes.length, concatPrefix(lenBytes, data));
}

function encodeList(items: RLPItem[]): Uint8Array {
  const payload: number[] = [];
  let payloadSize = 0;
  for (const item of items) {
    const enc = item instanceof Uint8Array ? encodeString(item) : encodeList(item);
    for (const b of enc) payload.push(b);
    payloadSize += enc.length;
  }
  const payloadBytes = Uint8Array.from(payload);
  if (payloadSize <= 55) {
    return prefix(0xc0 + payloadSize, payloadBytes);
  }
  const lenBytes = minimalBytes(BigInt(payloadSize));
  return prefix(0xf7 + lenBytes.length, concatPrefix(lenBytes, payloadBytes));
}

function prefix(firstByte: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.length);
  out[0] = firstByte;
  out.set(data, 1);
  return out;
}

function concatPrefix(len: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(len.length + data.length);
  out.set(len, 0);
  out.set(data, len.length);
  return out;
}

function minimalBytes(value: bigint): Uint8Array {
  if (value === 0n) return Uint8Array.of(0);
  const parts: number[] = [];
  let v = value;
  while (v > 0n) {
    parts.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Uint8Array.from(parts);
}

export function decode(data: Uint8Array): RLPItem {
  const [item, rest] = decodeItem(data);
  if (rest.length !== 0) throw new Error("rlp: trailing bytes after item");
  return item;
}

/**
 * Decodes exactly one item; returns the item and remaining bytes.
 * Mutative-safe: never aliases the input buffer beyond necessary slices.
 */
export function decodeItem(data: Uint8Array): [RLPItem, Uint8Array] {
  if (data.length === 0) throw new Error("rlp: empty input");
  const first = data[0];
  if (first < 0x80) return [data.subarray(0, 1), data.subarray(1)];
  if (first <= 0xb7) {
    const length = first - 0x80;
    return [data.subarray(1, 1 + length), data.subarray(1 + length)];
  }
  if (first < 0xc0) {
    const numLenBytes = first - 0xb7;
    const itemLen = readSize(data.subarray(1, 1 + numLenBytes));
    const start = 1 + numLenBytes;
    return [data.subarray(start, start + itemLen), data.subarray(start + itemLen)];
  }
  // list forms
  if (first <= 0xf7) {
    const payloadLen = first - 0xc0;
    const end = 1 + payloadLen;
    return [decodeListPayload(data.subarray(1, end)), data.subarray(end)];
  }
  const numLenBytes = first - 0xf7;
  const payloadLen = readSize(data.subarray(1, 1 + numLenBytes));
  const payloadStart = 1 + numLenBytes;
  const payload = data.subarray(payloadStart, payloadStart + payloadLen);
  const rest = data.subarray(payloadStart + payloadLen);
  return [decodeListPayload(payload), rest];
}

function decodeListPayload(payload: Uint8Array): RLPItem[] {
  const items: RLPItem[] = [];
  let rest = payload;
  while (rest.length > 0) {
    const [item, remainder] = decodeItem(rest);
    items.push(item);
    rest = remainder;
  }
  return items;
}

function readSize(bytes: Uint8Array): number {
  if (bytes.length > 8) throw new Error("rlp: size field too large");
  let size = 0;
  for (const b of bytes) size = size * 256 + b;
  if (size === 0) throw new Error("rlp: size field must be minimal");
  return size;
}

/** Helpers for common RLP usage patterns. */
export const RLP = {
  encode,
  decode,
  decodeItem,
  fromString(text: string): Uint8Array {
    return utf8ToBytes(text);
  },
  toString(bytes: Uint8Array): string {
    return bytesToUtf8(bytes);
  },
  /** Encodes an unsigned integer as a minimal big-endian byte string. */
  fromUint(value: bigint | number): Uint8Array {
    const v = typeof value === "number" ? BigInt(value) : value;
    if (v < 0n) throw new Error("negative values are not RLP-encodable");
    return minimalBytes(v);
  },
  /** Decodes a byte string into an unsigned big integer. */
  toUint(item: Uint8Array): bigint {
    let value = 0n;
    for (const b of item) value = (value << 8n) | BigInt(b);
    return value;
  },
};
