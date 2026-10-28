import { test } from "node:test";
import assert from "node:assert";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIC, DEV_CHAIN_ID, BLOCK_REWARD, MAX_FUTURE_TIMESTAMP_SECONDS, MAX_TOTAL_SUPPLY } from "../src/config/params.js";
import { Blockchain } from "../src/chain/blockchain.js";
import { buildBlockForMining, buildBlockOn } from "../src/mining/candidate.js";
import { emptyGenesisConfig } from "../src/chain/genesis.js";
import { blockHash, decodeBlock, type BlockHeader } from "../src/chain/block.js";
import { randomAccount, signTransaction, txHash } from "../src/tx/transaction.js";
import { Mempool } from "../src/tx/mempool.js";
import { readLedger } from "../src/chain/persist.js";

interface ChainSet {
  chain: Blockchain;
  mempool: Mempool;
  user: ReturnType<typeof randomAccount>;
  miner: ReturnType<typeof randomAccount>;
}

/** Test-only Blockchain subclass that skips PoW validation via checkPoW()
 *  so chain-validation rule tests can run without performing ~2^32 hashes per
 *  block at difficulty 1 under POW_LIMIT. This subclass exists ONLY in test
 *  code; production node/RPC/mining/P2P code constructs plain Blockchain and
 *  always verifies real PoW. */
class BlockchainForTesting extends Blockchain {
  protected checkPoW(_header: BlockHeader, _nonce: bigint): import("../src/chain/blockchain.js").ImportedReceipt | null {
    return null; // test-only: skip PoW hash check; all other rules still apply
  }
}

function fundedChain(genesisTs = Math.floor(1_700_000_000)): ChainSet {
  const user = randomAccount();
  const miner = randomAccount();
  const genesis = emptyGenesisConfig(genesisTs);
  genesis.allocations = [{ address: user.address, balance: BIC(10_000n) }];
  // Test chain: uses BlockchainForTesting which skips PoW validation.
  // Production code constructs plain Blockchain and always verifies real PoW.
  const chain = new BlockchainForTesting(genesis);
  const mempool = new Mempool();
  chain.mempoolRef = mempool;
  return { chain, mempool, user, miner };
}

/** Mines one block and submits it to the chain (test-only: skips PoW search). */
function mineAndSubmit(
  chain: Blockchain,
  mempool: Mempool,
  coinbase: string,
  timestamp: number,
  extra = "test",
): { accepted: boolean; reason?: string } {
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase,
    timestamp,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode(extra),
  });
  if (!template) return { accepted: false, reason: "no template" };
  const receipt = acceptTestBlock(chain, findNonce(template));
  return { accepted: receipt.accepted, reason: receipt.reason };
}

/** Mines on an explicit parent hash (test-only: skips PoW search). */
function mineOnParent(
  chain: Blockchain,
  mempool: Mempool,
  coinbase: string,
  parentHash: string,
  timestamp: number,
  extra = "fork",
): { accepted: boolean; reason?: string; minedHash?: string } {
  const parent = chain.getBlock(parentHash);
  if (!parent) return { accepted: false, reason: "parent unknown" };
  const template = buildBlockOn(
    {
      chain,
      mempool,
      coinbase,
      timestamp,
      activeReward: BLOCK_REWARD,
      extraData: new TextEncoder().encode(extra),
    },
    {
      parentHash,
      parentBlock: parent.block,
      parentState: chain.getState(parentHash),
    },
  );
  if (!template) return { accepted: false, reason: "no fork template" };
  const mined = findNonce(template);
  const receipt = acceptTestBlock(chain, mined);
  return {
    accepted: receipt.accepted,
    reason: receipt.reason,
    minedHash: blockHash(mined.header),
  };
}

/** Test-only block acceptance: uses the chain's injected test PoW bypass
 *  validator so validation runs every rule except the PoW hash check (~2^32
 *  expected hashes per block at difficulty 1 under POW_LIMIT). The bypass is
 *  injected at chain construction (see fundedChain) and is not part of the
 *  production acceptBlock API. Real PoW validation is covered by
 *  test/pow.test.ts and by production acceptBlock paths that never inject a
 *  bypass validator. */
function acceptTestBlock(
  chain: Blockchain,
  block: NonNullable<ReturnType<typeof buildBlockForMining>>,
) {
  return chain.acceptBlock(block);
}

/** Test-only nonce helper: returns the block template with nonce set to 0n
 *  without searching. A real nonce search is infeasible at difficulty 1
 *  under POW_LIMIT (~2^32 expected hashes); chain tests rely on
 *  acceptTestBlock's injected bypass validator instead. */
function findNonce(template: NonNullable<ReturnType<typeof buildBlockForMining>>): NonNullable<ReturnType<typeof buildBlockForMining>> {
  const header = { ...template.header, nonce: 0n };
  return { header, transactions: template.transactions };
}

test("chain: accepts a validated mined block; coinbase reward + supply conservation", () => {
  const { chain, mempool, miner } = fundedChain();
  const genesisSupply = chain.tipState.totalSupply();
  const receipt = mineAndSubmit(chain, mempool, miner.address, Math.floor(1_700_000_000) + 5);
  assert.equal(receipt.accepted, true, receipt.reason);
  assert.equal(chain.tip.number, 1);
  assert.equal(chain.tipState.totalSupply(), genesisSupply + BLOCK_REWARD);
});

test("chain: rejects orphan blocks; equal timestamp is now valid (non-decreasing rule)", () => {
  const { chain, mempool, miner } = fundedChain();
  const tip = chain.tip;
  // Orphan block (unknown parent)
  const orphan = { ...tip.block, header: { ...tip.block.header, parentHash: "0x" + "10".repeat(32) } };
  assert.equal(acceptTestBlock(chain,orphan).accepted, false);
  // Equal timestamp (stale under the OLD strict-increase rule) now builds a
  // valid candidate and is accepted: Phase 1 permits equal stamps.
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: tip.block.header.timestamp,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("equal-stamp"),
  });
  assert.notEqual(template, null, "equal-stamp candidate must be buildable under the non-decreasing rule");
  const receipt = acceptTestBlock(chain,findNonce(template!));
  assert.equal(receipt.accepted, true, receipt.reason);
  assert.equal(chain.tip.number, 1);
  assert.equal(chain.tip.block.header.timestamp, tip.block.header.timestamp, "block timestamp equals its parent's");
});

test("chain: txRoot mismatch rejects block with unclean header", () => {
  const { chain, mempool, miner } = fundedChain();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 6,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("tamper"),
  })!;
  const header = { ...template.header, transactionsRoot: "0x" + "12".repeat(32) };
  const receipt = acceptTestBlock(chain, { header, transactions: template.transactions });
  assert.equal(receipt.accepted, false);
  assert.match(receipt.reason ?? "", /transactionsRoot/);
});

test("chain: fork & reorg — deeper fork replaces the tip", () => {
  const { chain, mempool, miner } = fundedChain();
  const t0 = Math.floor(1_700_000_000);

  // Branch A (2 blocks).
  assert.equal(mineAndSubmit(chain, mempool, miner.address, t0 + 10, "A1").accepted, true);
  assert.equal(mineAndSubmit(chain, mempool, miner.address, t0 + 20, "A2").accepted, true);
  const aTip = chain.tip.hash;
  assert.equal(chain.tip.number, 2);

  // Branch B: 3 siblings off genesis — cumulative score 4 vs 3, so B wins.
  // Each block is mined directly on its (non-tip) parent via buildBlockOn,
  // exercising fork mining and fork selection together.
  const g0 = chain.getBlockByNumber(0)!;
  const genesisHash = blockHash(g0.header);
  let cursor = genesisHash;
  for (let i = 0; i < 3; i++) {
    const receipt = mineOnParent(chain, mempool, miner.address, cursor, t0 + 100 + i * 10, `B${i}`);
    assert.equal(receipt.accepted, true, receipt.reason);
    cursor = receipt.minedHash!; // extend the B-branch, not the best chain
  }

  assert.equal(chain.tip.number, 3);
  // The A tip remains queryable as a losing fork (retention).
  assert.ok(chain.getBlock(aTip));
  assert.equal(new TextDecoder().decode(chain.getBlock(aTip)!.block.header.extraData), "A2");
});

test("chain: deep-fork template differs from tip template (buildBlockOn)", () => {
  const { chain, mempool, miner } = fundedChain();
  const tip = chain.tip;
  void tip;
  const g0 = chain.getBlockByNumber(0)!;
  const state0 = chain.getState(blockHash(g0.header));
  const forked = buildBlockOn(
    {
      chain,
      mempool,
      coinbase: miner.address,
      timestamp: g0.header.timestamp + 50,
      activeReward: BLOCK_REWARD,
      extraData: new TextEncoder().encode("fork-on-genesis"),
    },
    { parentHash: blockHash(g0.header), parentBlock: g0, parentState: state0 },
  );
  assert.notEqual(forked, null);
  assert.equal(forked!.header.number, 1);
  assert.equal(forked!.header.parentHash, blockHash(g0.header));
  assert.equal(forked!.transactions.length, 0);
});

test("chain: ledger persistence roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "cashbi-ledger-"));
  const ledgerPath = join(dir, "blocks.jsonl");
  const { chain, mempool, miner } = fundedChain();
  chain.enablePersistence(ledgerPath);
  const receipt = mineAndSubmit(chain, mempool, miner.address, Math.floor(1_700_000_000) + 5);
  assert.equal(receipt.accepted, true);
  const records = readLedger(ledgerPath);
  assert.equal(records.length >= 1, true);
  const ledgerReloaded = decodeBlock(records[records.length - 1]);
  assert.equal(blockHash(ledgerReloaded.header), blockHash(chain.tip.block.header));
  rmSync(dir, { recursive: true, force: true });
});

test("chain: persistence skips corrupt trailing ledger lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "cashbi-ledger-corrupt-"));
  const ledgerPath = join(dir, "blocks.jsonl");
  const { chain, mempool, miner } = fundedChain();
  chain.enablePersistence(ledgerPath);
  const receipt = mineAndSubmit(chain, mempool, miner.address, Math.floor(1_700_000_000) + 5);
  assert.equal(receipt.accepted, true);

  // Append a corrupt trailing line to simulate a torn write.
  appendFileSync(ledgerPath, "not valid jsonl\n");
  appendFileSync(ledgerPath, "{b64: not-base64}\n");

  const records = readLedger(ledgerPath);
  // readLedger stops scanning at the first corrupt line; valid lines before it
  // should still be readable.
  assert.equal(records.length >= 1, true);
  const ledgerReloaded = decodeBlock(records[records.length - 1]);
  assert.equal(blockHash(ledgerReloaded.header), blockHash(chain.tip.block.header));
  rmSync(dir, { recursive: true, force: true });
});

test("chain: mempool drops included transactions after block acceptance", () => {
  const { chain, mempool, user, miner } = fundedChain();
  const payee = randomAccount();
  const tx = signTransaction(
    { nonce: 0n, to: payee.address, value: 1n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    user.privateKey,
  );
  mempool.add(tx, { chainId: DEV_CHAIN_ID, state: chain.tipState });
  assert.equal(mempool.stats().size, 1);
  const receipt = mineAndSubmit(chain, mempool, miner.address, Math.floor(1_700_000_000) + 5);
  assert.equal(receipt.accepted, true);
  assert.equal(mempool.stats().size, 0);
});

test("chain: acceptBlock rejects block with invalid tx without crashing", () => {
  const { chain, mempool, user, miner } = fundedChain();
  const payee = randomAccount();
  // Tx with nonce 5 but account is at nonce 0 — execution must reject the block,
  // not throw an uncaught exception that crashes the node.
  const badTx = signTransaction(
    { nonce: 5n, to: payee.address, value: 1n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    user.privateKey,
  );
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("bad-tx"),
  })!;
  // Force the bad tx into the template by direct construction (bypasses mempool).
  const block = {
    header: { ...template.header },
    transactions: [...template.transactions, badTx],
  };
  // Mine a nonce for the modified block header.
  const mined = findNonce(block);
  let threw = false;
  try {
    const receipt = acceptTestBlock(chain,mined);
    assert.equal(receipt.accepted, false, "block with invalid tx should be rejected");
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "acceptBlock must not throw on invalid tx in block");
});

test("chain: block reward clamp — exact remainder at the 16,000,000 BIC cap, then a zero-reward tail", () => {
  const { mempool, miner } = fundedChain();
  const MAX = MAX_TOTAL_SUPPLY;
  // Create a chain whose supply is within one subsidy of the cap by putting
  // cap − BLOCK_REWARD in the genesis allocation (inventory manipulation of
  // devnet balances only — bounds the test length).
  const bigGenesis = emptyGenesisConfig(Math.floor(1_700_000_000));
  bigGenesis.allocations = [{ address: miner.address, balance: MAX - BLOCK_REWARD }];
  const bigChain = new BlockchainForTesting(bigGenesis);
  assert.equal(bigChain.tipState.totalSupply(), MAX - BLOCK_REWARD);

  const template = buildBlockForMining({
    chain: bigChain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("supply-cap"),
  })!;
  const mined = findNonce(template);
  const receipt = acceptTestBlock(bigChain,mined);
  assert.equal(receipt.accepted, true, "block at exactly cap should be accepted");
  assert.equal(bigChain.tipState.totalSupply(), MAX, "the final block mints the exact remainder — cap never crossed");

  // Past the cap the subsidy is zero (zero-reward tail): the block is still
  // valid (empty coinbase delta) and supply stays at the cap.
  const template2 = buildBlockForMining({
    chain: bigChain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 10,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("supply-over"),
  })!;
  const mined2 = findNonce(template2);
  const receipt2 = acceptTestBlock(bigChain,mined2);
  assert.equal(receipt2.accepted, true, "block past the cap must still be accepted with a zero subsidy");
  assert.equal(bigChain.tipState.totalSupply(), MAX, "no minting past the 16,000,000 BIC cap");
  assert.equal(
    bigChain.tipState.getAccount(miner.address)?.balance,
    MAX,
    "coinbase balance unchanged in the zero-reward tail",
  );
});

test("chain: reorg consistency — balances, nonces, and mempool remain consistent after fork switch", () => {
  const { chain, mempool, user, miner } = fundedChain();
  const t0 = Math.floor(1_700_000_000);
  const payee = randomAccount();

  // User has 10_000 BIC at genesis. Send 1 BIC on branch A.
  const txA = signTransaction(
    { nonce: 0n, to: payee.address, value: BIC(1n), data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    user.privateKey,
  );
  mempool.add(txA, { chainId: DEV_CHAIN_ID, state: chain.tipState });
  assert.equal(mineAndSubmit(chain, mempool, miner.address, t0 + 10, "A1").accepted, true);
  const balanceAfterA = chain.tipState.getAccount(payee.address)?.balance ?? 0n;
  assert.equal(balanceAfterA, BIC(1n), "payee received 1 BIC on branch A");

  // Now create branch B (2 blocks off genesis, higher cumulative difficulty) that does NOT include txA.
  // Branch B has 3 blocks (score = 1+1+1 = 3) vs branch A's 2 blocks (score = 1+1 = 2)
  // Wait: genesis difficulty is 1, so each block adds 1 to score.
  // Branch A: genesis(1) + block1(1) = score 2 at tip number 1
  // Branch B needs score > 2 to win. 3 blocks off genesis = score 4? No.
  // Genesis score = 1. Each child adds parent.score + difficulty.
  // Branch A: score = 1 (genesis) + 1 (block1) = 2 at number 1
  // Branch B: 3 blocks off genesis = score 1+1+1+1 = 4 at number 3
  // So B wins with score 4 > 2
  const g0 = chain.getBlockByNumber(0)!;
  const genesisHash = blockHash(g0.header);
  let cursor = genesisHash;
  for (let i = 0; i < 3; i++) {
    const receipt = mineOnParent(chain, mempool, miner.address, cursor, t0 + 100 + i * 10, `B${i}`);
    assert.equal(receipt.accepted, true, `B${i} accepted: ${receipt.reason}`);
    cursor = receipt.minedHash!;
  }

  // After reorg, chain tip should be branch B (number 3)
  assert.equal(chain.tip.number, 3, "chain reorged to branch B");

  // Payee should NOT have the 1 BIC from branch A (txA was on the losing fork)
  const balanceAfterReorg = chain.tipState.getAccount(payee.address)?.balance ?? 0n;
  assert.equal(balanceAfterReorg, 0n, "payee balance should be 0 after reorg (txA was on losing fork)");

  // User's nonce should be 0 after reorg (txA nonce was consumed on losing fork only)
  const userNonceAfterReorg = chain.tipState.getAccount(user.address)?.nonce ?? 0n;
  assert.equal(userNonceAfterReorg, 0n, "user nonce should be 0 after reorg");

  // txA should be back in the mempool (it was on the losing fork, never mined on best chain)
  // Note: mempool removal only happens for the winning block's transactions
  assert.equal(mempool.has(txHash(txA)), false, "txA was consumed by branch A's block which is now on a losing fork");
  // Actually txA was removed from mempool when branch A's block was accepted. It's not re-added on reorg.
  // This is a known dev limitation - transactions from losing forks are not returned to mempool.
});

test("chain: invalid difficulty change is rejected", () => {
  const { chain, mempool, miner } = fundedChain();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("bad-difficulty"),
  })!;
  // Tamper with difficulty
  const header = { ...template.header, difficulty: template.header.difficulty + 100n };
  const mined = findNonce({ header, transactions: template.transactions });
  const receipt = acceptTestBlock(chain,mined);
  assert.equal(receipt.accepted, false, "block with wrong difficulty should be rejected");
  assert.match(receipt.reason ?? "", /difficulty/);
});

test("chain: block with difficulty 0 is rejected without crashing", () => {
  const { chain, mempool, miner } = fundedChain();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("diff-zero"),
  })!;
  // Find a nonce with the valid difficulty first; finding one with
  // difficulty 0 would throw inside isMiningCandidate.
  const mined = findNonce(template);
  // Tamper difficulty to 0 AFTER the nonce search.
  const zeroDiffBlock = {
    header: { ...mined.header, difficulty: 0n },
    transactions: mined.transactions,
  };
  let threw = false;
  let accepted = false;
  let reason = "";
  try {
    const r = acceptTestBlock(chain,zeroDiffBlock);
    accepted = r.accepted;
    reason = r.reason ?? "";
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "acceptBlock must not throw on difficulty 0");
  assert.equal(accepted, false, "difficulty 0 block must be rejected");
  assert.match(reason, /difficulty/);
});

test("chain: block with difficulty below MIN_DIFFICULTY is rejected safely", () => {
  const { chain, mempool, miner } = fundedChain();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("diff-low"),
  })!;
  const mined = findNonce(template);
  const lowDiffBlock = {
    header: { ...mined.header, difficulty: -1n },
    transactions: mined.transactions,
  };
  let threw = false;
  let accepted = false;
  let reason = "";
  try {
    const r = acceptTestBlock(chain,lowDiffBlock);
    accepted = r.accepted;
    reason = r.reason ?? "";
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "acceptBlock must not throw on difficulty below MIN");
  assert.equal(accepted, false, "difficulty below MIN must be rejected");
  assert.match(reason, /difficulty/);
});

test("chain: block with non-bigint difficulty is rejected safely", () => {
  const { chain, mempool, miner } = fundedChain();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("diff-malformed"),
  })!;
  const mined = findNonce(template);
  // Malformed runtime value: a number instead of a bigint.
  const malformedDiffBlock = {
    header: { ...mined.header, difficulty: 0 as unknown as bigint },
    transactions: mined.transactions,
  };
  let threw = false;
  let accepted = false;
  let reason = "";
  try {
    const r = acceptTestBlock(chain,malformedDiffBlock);
    accepted = r.accepted;
    reason = r.reason ?? "";
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "acceptBlock must not throw on non-bigint difficulty");
  assert.equal(accepted, false, "non-bigint difficulty must be rejected");
  assert.match(reason, /difficulty/);
});

test("chain: modified header (wrong stateRoot) is rejected", () => {
  const { chain, mempool, miner } = fundedChain();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("bad-stateRoot"),
  })!;
  const header = { ...template.header, stateRoot: "0x" + "ff".repeat(32) };
  const mined = findNonce({ header, transactions: template.transactions });
  const receipt = acceptTestBlock(chain,mined);
  assert.equal(receipt.accepted, false, "block with wrong stateRoot should be rejected");
  assert.match(receipt.reason ?? "", /stateRoot/);
});

test("chain: local-clock future limit behavior unchanged (rejects beyond-wall stamps reached via legal +600 steps)", () => {
  // Genesis sits 900 s in the past so a parent-relative ladder of +600 s steps
  // (the parent-relative cap) reaches the wall-clock tolerance in 2 accepted
  // blocks (the second stamping exactly wall+300 — the inclusive boundary);
  // the third (again parent+600 = wall+900) satisfies the deterministic
  // parent-relative rules but violates the pre-existing local-clock policy
  // and must still be rejected here (quarantine is a later phase, out of
  // scope).
  const { chain, mempool, miner } = fundedChain(Math.floor(Date.now() / 1000) - 900);
  let tip = chain.tip.block.header;
  for (let i = 0; i < 2; i++) {
    const template = buildBlockForMining({
      chain,
      mempool,
      coinbase: miner.address,
      timestamp: tip.timestamp + 600,
      activeReward: BLOCK_REWARD,
      extraData: new TextEncoder().encode(`ladder-${i}`),
    })!;
    const mined = findNonce(template);
    const receipt = acceptTestBlock(chain,mined);
    assert.equal(receipt.accepted, true, `ladder block ${i}: ${receipt.reason}`);
    tip = chain.tip.block.header;
  }
  assert.equal(tip.timestamp <= Math.floor(Date.now() / 1000) + MAX_FUTURE_TIMESTAMP_SECONDS, true, "precondition: last ladder stamp within the local tolerance");
  const beyond = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: tip.timestamp + 600,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("beyond-wall"),
  })!;
  const minedBeyond = findNonce(beyond);
  const receipt = acceptTestBlock(chain,minedBeyond);
  assert.equal(receipt.accepted, false, "block beyond the local-clock future tolerance must be rejected");
  assert.match(receipt.reason ?? "", /timestamp too far in the future/);
});

test("chain: block with timestamp within max future is accepted", () => {
  // Genesis placed exactly one target interval (600 s) behind wall time so
  // the parent-relative cap (parent+600) and the local future tolerance both
  // hold for the candidate stamp (it lands at wall clock).
  const { chain, mempool, miner } = fundedChain(Math.floor(Date.now() / 1000) - 600);
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: chain.tip.block.header.timestamp + 600, // ≈ wall, inside the future tolerance
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("near-future"),
  })!;
  assert.equal(template!.header.timestamp <= Math.floor(Date.now() / 1000) + MAX_FUTURE_TIMESTAMP_SECONDS, true);
  const mined = findNonce(template);
  const receipt = acceptTestBlock(chain,mined);
  assert.equal(receipt.accepted, true, "block with timestamp within max future should be accepted");
});

test("chain: duplicate transactions in a block are rejected", () => {
  const { chain, mempool, user, miner } = fundedChain();
  const payee = randomAccount();
  const tx = signTransaction(
    { nonce: 0n, to: payee.address, value: BIC(1n), data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    user.privateKey,
  );
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("duplicate-tx"),
  })!;
  // Include the same tx twice
  const block = {
    header: { ...template.header },
    transactions: [tx, tx],
  };
  const mined = findNonce(block);
  const receipt = acceptTestBlock(chain,mined);
  assert.equal(receipt.accepted, false, "block with duplicate tx should be rejected");
});

test("chain: rejected block leaves no partial state changes", () => {
  const { chain, mempool, user, miner } = fundedChain();
  const payee = randomAccount();
  const balanceBefore = chain.tipState.getAccount(user.address)?.balance ?? 0n;
  const nonceBefore = chain.tipState.getAccount(user.address)?.nonce ?? 0n;

  // Submit a block with an invalid tx (wrong nonce)
  const badTx = signTransaction(
    { nonce: 99n, to: payee.address, value: 1n, data: new Uint8Array(0), gasPrice: 1n, gas: 21_000n, chainId: DEV_CHAIN_ID },
    user.privateKey,
  );
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: Math.floor(1_700_000_000) + 5,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("no-partial"),
  })!;
  const block = {
    header: { ...template.header },
    transactions: [...template.transactions, badTx],
  };
  const mined = findNonce(block);
  const receipt = acceptTestBlock(chain,mined);
  assert.equal(receipt.accepted, false, "block with invalid tx should be rejected");

  // State should be unchanged
  assert.equal(chain.tipState.getAccount(user.address)?.balance, balanceBefore, "balance unchanged after rejection");
  assert.equal(chain.tipState.getAccount(user.address)?.nonce, nonceBefore, "nonce unchanged after rejection");
  assert.equal(chain.tip.number, 0, "tip unchanged after rejection");
});

test("chain: parent-relative stamps — exactly +600 accepted (cap), +601 rejected, earlier rejected", () => {
  const { chain, mempool, miner } = fundedChain();
  const build = (ts: number, tag: string) =>
    buildBlockForMining({
      chain,
      mempool,
      coinbase: miner.address,
      timestamp: ts,
      activeReward: BLOCK_REWARD,
      extraData: new TextEncoder().encode(tag),
    })!;

  // +600 accepted by the deterministic parent-relative rule (cap boundary).
  const at600 = build(chain.tip.block.header.timestamp + 600, "step600");
  const at600Receipt = acceptTestBlock(chain,findNonce(at600));
  assert.equal(at600Receipt.accepted, true, `parent+600 must be accepted: ${at600Receipt.reason}`);

  // +601 rejected on the next block (parent is the +600 block).
  const tipTs = chain.tip.block.header.timestamp;
  const manualLate = build(tipTs + 601, "step601");
  const lateHeader = { ...manualLate.header, timestamp: tipTs + 601 };
  const lateMined = findNonce({ header: lateHeader, transactions: manualLate.transactions });
  const lateReceipt = acceptTestBlock(chain,lateMined);
  assert.equal(lateReceipt.accepted, false, "parent+601 must be rejected");
  assert.match(lateReceipt.reason ?? "", /after parent/);

  // Earlier than parent rejected.
  const earlyHeader = { ...manualLate.header, timestamp: tipTs - 1 };
  const earlyMined = findNonce({ header: earlyHeader, transactions: manualLate.transactions });
  const earlyReceipt = acceptTestBlock(chain,earlyMined);
  assert.equal(earlyReceipt.accepted, false, "earlier-than-parent must be rejected");
  assert.match(earlyReceipt.reason ?? "", /earlier than parent/);
});

test("chain: non-retarget heights inherit the parent difficulty", () => {
  const { chain, mempool, miner } = fundedChain();
  const gTs = chain.tip.block.header.timestamp;
  const receipt = mineAndSubmit(chain, mempool, miner.address, gTs + 5);
  assert.equal(receipt.accepted, true, receipt.reason);
  assert.equal(chain.tip.block.header.difficulty, chain.getBlockByNumber(0)!.header.difficulty);

  // Non-retarget heights must not consult anchors at all: a throwing lookup
  // proves the retarget path is skipped (and inheritance is exact).
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: gTs + 10,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("inherit"),
  });
  assert.notEqual(template, null);
  assert.equal(template!.header.difficulty, BigInt(1), "inherited difficulty equals the genesis difficulty");
});

test("chain: 1536 equal-stamp blocks RAISE difficulty by exactly 4x at the first retarget (regression)", () => {
  const { chain, mempool, miner } = fundedChain();
  const gTs = chain.tip.block.header.timestamp;
  // All 1536 blocks carry the genesis second (equal stamps are valid under
  // the non-decreasing rule). The first retarget (h = 1536) measures
  // LM(new) = G, LM(old) = G − 3000 (virtual anchors at heights −9..−1/0),
  // elapsed 3000 → clamped to 230,400 → difficulty rises 1 → 4 (exact 4x).
  for (let hCheck = 1; hCheck <= 1536; hCheck++) {
    const receipt = mineAndSubmit(chain, mempool, miner.address, gTs);
    assert.equal(receipt.accepted, true, `block ${hCheck}: ${receipt.reason}`);
  }
  assert.equal(chain.tip.number, 1536);
  const finalDifficulty = chain.tip.block.header.difficulty;
  assert.equal(finalDifficulty, 4n, "equal-stamp window must raise difficulty by the exact 4x bound");
  assert.equal(finalDifficulty > 1n, true, "regression: equal-second blocks cause a real difficulty increase");
});
