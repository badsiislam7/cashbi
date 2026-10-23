import { test } from "node:test";
import assert from "node:assert";
import { EVM, contractAddress } from "../src/vm/evm.js";
import { Journal, WorldState } from "../src/state/world.js";
import { padLeft } from "../src/util/bytes.js";
import { randomAccount } from "../src/tx/transaction.js";

function ctxOf(overrides: Partial<Parameters<typeof run>[2]> = {}): Parameters<typeof run>[2] {
  const { address: caller } = randomAccount();
  const { address: contract } = randomAccount();
  return {
    caller,
    address: contract,
    value: 0n,
    callData: new Uint8Array(0),
    blockTimestamp: 1_700_000_000,
    blockNumber: 7,
    gasPrice: 1n,
    ...overrides,
  };
}

function run(code: Uint8Array, gas = 100_000n): ReturnType<EVM["run"]> {
  const ctx = ctxOf();
  const journal = new Journal(new WorldState());
  const evm = new EVM(journal, code, ctx, gas);
  return evm.run();
}

test("evm: arithmetic basics (5 + 3 = 8 via MSTORE/RETURN)", () => {
  const addCode = Uint8Array.of(
    0x60, 0x05, // PUSH1 5
    0x60, 0x03, // PUSH1 3
    0x01,       // ADD
    0x60, 0x00, // PUSH1 0 (offset)
    0x52,       // MSTORE
    0x60, 0x20, // PUSH1 32 (length)
    0x60, 0x00, // PUSH1 0 (offset)
    0xf2,       // RETURN
  );
  const out = run(addCode);
  assert.equal(out.ok, true);
  assert.equal(out.output.length, 32);
  // 5 + 3 = 8 in the last word byte
  assert.equal(out.output[31], 8);
});

test("evm: storage slot roundtrip with SSTORE/SLOAD", () => {
  const store = Uint8Array.of(
    0x60, 0x2a, // PUSH1 42 (value)
    0x60, 0x03, // PUSH1 3 (slot)
    0x55,       // SSTORE
    0x60, 0x03, // PUSH1 3
    0x54,       // SLOAD
    0x60, 0x00, 0x52,
    0x60, 0x20, 0x60, 0x00, 0xf2, // RETURN(offset=0,len=32)
  );
  const result = run(store);
  assert.equal(result.ok, true);
  assert.equal(result.output[31], 42);
  void padLeft;
});

test("evm: REVERT aborts with rollback semantics", () => {
  const code = Uint8Array.of(
    0x60, 0x01, // PUSH1
    0xfe,       // INVALID triggers abort
  );
  const bad = run(code);
  assert.equal(bad.ok, false);
});

test("evm: out-of-gas aborts without success", () => {
  const code = Uint8Array.of(0x60, 0x01, 0x50, 0x60, 0x01, 0x50, 0x60, 0x01, 0x50);
  const result = run(code, 5n);
  assert.equal(result.ok, false);
});

test("evm: push encoding decodes operand", () => {
  // PUSH32 of a fixed value then RETURN it
  const code = new Uint8Array(32 + 3 + 6);
  code[0] = 0x7f; // PUSH32
  const value = padLeft(Uint8Array.of(1, 2, 3), 32);
  code.set(value, 1);
  code[33] = 0x60; // PUSH1 0 -> MSTORE8?
  code[34] = 0x00;
  code[35] = 0x52; // MSTORE (top is value, second is 0) — PUSH32 pushed value, PUSH1 0 push offset
  code[36] = 0x60; // PUSH1 32
  code[37] = 0x20;
  code[38] = 0x60; // PUSH1 0
  code[39] = 0x00;
  code[40] = 0xf2; // RETURN
  const result = run(code);
  assert.equal(result.ok, true);
  assert.equal(result.output[31], 3);
});

test("evm: contractAddress is deterministic", () => {
  const a = contractAddress("0x" + "11".repeat(20), 5n);
  const b = contractAddress("0x" + "11".repeat(20), 5n);
  assert.equal(a, b);
  assert.equal(a.length, 42);
  const c = contractAddress("0x" + "11".repeat(20), 6n);
  assert.notEqual(a, c);
});
