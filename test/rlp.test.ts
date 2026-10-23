import { test } from "node:test";
import assert from "node:assert";
import { RLP, decode, encode, RLPItem } from "../src/rlp/rlp.js";
import { fromHex, toHex, utf8ToBytes } from "../src/util/bytes.js";

const vec = (hex: string): Uint8Array => fromHex(hex.replace(/^0x/, ""));

test("rlp: cattle vectors", () => {
  // 'dog' -> 0x83646f67
  assert.equal(toHex(encode(utf8ToBytes("dog"))), "0x83646f67");
  // 'cat' -> 0x83'cat'
  assert.equal(toHex(encode(utf8ToBytes("cat"))), "0x83636174");
  // 0 char
  assert.equal(toHex(encode(new Uint8Array(0))), "0x80");
  // single byte < 0x80
  assert.equal(toHex(encode(new Uint8Array([0x00]))), "0x00");
  assert.equal(toHex(encode(new Uint8Array([0x7f]))), "0x7f");
  // 55-char string long form boundary
  const long55 = "A".repeat(55);
  const enc55 = toHex(encode(utf8ToBytes(long55)));
  assert.equal(enc55.slice(2, 4), "b7"); // 0xb7 prefix
  // short string
  const long54 = "A".repeat(54);
  assert.equal(toHex(encode(utf8ToBytes(long54))).slice(2, 4), "b6"); // 0x80+54
});

test("rlp: canonical structure vectors (spec-derived)", () => {
  // ["cat"]  -> 0xc483636174
  assert.equal(toHex(encode([utf8ToBytes("cat")])), "0xc483636174");
  // [ [], "cat" ] -> 0xc5c083636174  (empty list = c0, empty string in list = 80)
  assert.equal(toHex(encode([new Uint8Array(0), utf8ToBytes("cat")])), "0xc58083636174");
  // [ [ [], "cat" ] ]
  assert.equal(toHex(encode([[new Uint8Array(0), utf8ToBytes("cat")]])), "0xc6c58083636174");
  // minimal big-endian integer bytes 0x0400 => 0x820400
  assert.equal(toHex(encode(RLP.fromUint(1024))), "0x820400");
});

test("rlp: nested roundtrip", () => {
  const item: RLPItem = [
    utf8ToBytes("hello"),
    [utf8ToBytes("world"), [new Uint8Array([1, 2, 3])]],
    new Uint8Array(0),
  ];
  const encoded = encode(item);
  const decoded = decode(encoded) as RLPItem;
  assert.deepEqual(toHex(encode(decoded)), toHex(encoded));
});

test("rlp: big integer helpers", () => {
  assert.equal(toHex(RLP.fromUint(0n)), toHex(new Uint8Array([0])));
  assert.equal(toHex(RLP.fromUint(1n)), "0x01");
  assert.equal(RLP.toUint(vec("0x0f")), 15n);
  assert.equal(RLP.toUint(vec("0xdeadbeef")), 0xdeadbeefn);
});

test("rlp: decode rejects trailing garbage", () => {
  assert.throws(() => decode(new Uint8Array([])));
  const enc = encode(utf8ToBytes("dog"));
  assert.throws(() => decode(new Uint8Array([...enc, 0x01])));
});
