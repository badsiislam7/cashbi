import { test } from "node:test";
import assert from "node:assert";
import {
  decodeSignedTransaction,
  encodeSignedTransaction,
  recoverTransactionSender,
  signTransaction,
  txHash,
  validateTransaction,
  randomAccount,
  type TransactionBody,
} from "../src/tx/transaction.js";
import { Mempool } from "../src/tx/mempool.js";
import { WorldState } from "../src/state/world.js";
import { DEV_CHAIN_ID, BIC } from "../src/config/params.js";

function fundedState(alloc: Array<{ address: string; balance: bigint }>): WorldState {
  return WorldState.fromGenesisAllocations(alloc);
}

test("tx: sign -> encode -> decode -> recover sender", () => {
  const { address: from, privateKey } = randomAccount();
  const { address: to } = randomAccount();
  const tx = signTransaction(
    { nonce: 3n, to, value: 1000n, data: new Uint8Array(0), gasPrice: 2n, gas: 21000n, chainId: DEV_CHAIN_ID },
    privateKey,
  );
  const raw = encodeSignedTransaction(tx);
  const decoded = decodeSignedTransaction(raw);
  assert.equal(txHash(tx), txHash(decoded));
  assert.equal(recoverTransactionSender(decoded, DEV_CHAIN_ID), from);
  assert.equal(decoded.nonce, 3n);
  assert.equal(decoded.value, 1000n);
});

test("tx: EIP-155 replay protection (wrong chain id rejected)", () => {
  const { address: to } = randomAccount();
  const { privateKey } = randomAccount();
  const body: TransactionBody = {
    nonce: 0n,
    to,
    value: 1n,
    data: new Uint8Array(),
    gasPrice: 1n,
    gas: 21_001n,
    chainId: DEV_CHAIN_ID,
  };
  const tx = signTransaction(body, privateKey);
  assert.throws(() => recoverTransactionSender(tx, DEV_CHAIN_ID + 1));
});

test("tx: structuration rules", () => {
  const { privateKey } = randomAccount();
  const { address: to } = randomAccount();
  const balance = BIC(1n);
  const ctx = { chainId: DEV_CHAIN_ID, senderNonce: 0n, senderBalance: balance };
  // valid
  validateTransaction(
    signTransaction({ nonce: 0n, to, value: 5n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_005n, chainId: DEV_CHAIN_ID }, privateKey),
    ctx,
  );
  // insufficient balance
  const broke = signTransaction({ nonce: 0n, to, value: balance * 10n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID }, privateKey);
  assert.throws(() => validateTransaction(broke, ctx));
  // nonce too low
  assert.throws(() => validateTransaction(broke, { ...ctx, senderNonce: 5n }));
});

test("mempool: duplicate rejection, wallet checks, fee sorting, future nonce window", () => {
  const alice = randomAccount();
  const bob = randomAccount();
  const rich = fundedState([{ address: alice.address, balance: 10n ** 18n }]);
  const pool = new Mempool();
  const tx = signTransaction(
    { nonce: 0n, to: bob.address, value: 1n, data: new Uint8Array(0), gasPrice: 3n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    alice.privateKey,
  );
  const txHighFee = signTransaction(
    { nonce: 1n, to: bob.address, value: 1n, data: new Uint8Array(0), gasPrice: 9n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    alice.privateKey,
  );
  const first = pool.add(tx, { chainId: DEV_CHAIN_ID, state: rich });
  assert.equal(first.added, true);
  assert.equal(pool.add(tx, { chainId: DEV_CHAIN_ID, state: rich }).added, false); // duplicate
  assert.equal(pool.add(txHighFee, { chainId: DEV_CHAIN_ID, state: rich }).added, true);
  // future nonce is allowed into the pool (execution window)
  const future = signTransaction(
    { nonce: 5n, to: bob.address, value: 1n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    alice.privateKey,
  );
  assert.equal(pool.add(future, { chainId: DEV_CHAIN_ID, state: rich }).added, true);
  // insufficient balance at tip rejected
  const poor = WorldState.fromGenesisAllocations([{ address: alice.address, balance: 1n }]);
  const beyond = signTransaction(
    { nonce: 10n, to: bob.address, value: 10n ** 18n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    alice.privateKey,
  );
  assert.equal(pool.add(beyond, { chainId: DEV_CHAIN_ID, state: poor }).added, false);
  const ordered = pool.snapshot();
  assert.equal(ordered[0].gasPrice > ordered[1].gasPrice, true);
});
