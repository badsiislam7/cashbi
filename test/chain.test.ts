import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMiningCandidate } from "../src/consensus/pow.js";
import { BIC, DEV_CHAIN_ID, BLOCK_REWARD } from "../src/config/params.js";
import { Blockchain } from "../src/chain/blockchain.js";
import { buildBlockForMining, buildBlockOn } from "../src/mining/candidate.js";
import { emptyGenesisConfig } from "../src/chain/genesis.js";
import { blockHash, decodeBlock } from "../src/chain/block.js";
import { randomAccount, signTransaction, txHash } from "../src/tx/transaction.js";
import { Mempool } from "../src/tx/mempool.js";
import { readLedger } from "../src/chain/persist.js";

interface ChainSet {
  chain: Blockchain;
  mempool: Mempool;
  user: ReturnType<typeof randomAccount>;
  miner: ReturnType<typeof randomAccount>;
}

function fundedChain(): ChainSet {
  const user = randomAccount();
  const miner = randomAccount();
  const genesis = emptyGenesisConfig(Math.floor(1_700_000_000));
  genesis.allocations = [{ address: user.address, balance: BIC(10_000n) }];
  const chain = new Blockchain(genesis);
  const mempool = new Mempool();
  chain.mempoolRef = mempool;
  return { chain, mempool, user, miner };
}

/** Mines one block (nonce search) and submits it to the chain. */
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
  const receipt = chain.acceptBlock(findNonce(template));
  return { accepted: receipt.accepted, reason: receipt.reason };
}

/** Mines on an explicit parent hash (real fork mining via the queue). */
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
  const receipt = chain.acceptBlock(mined);
  return {
    accepted: receipt.accepted,
    reason: receipt.reason,
    minedHash: blockHash(mined.header),
  };
}

function findNonce(template: NonNullable<ReturnType<typeof buildBlockForMining>>): NonNullable<ReturnType<typeof buildBlockForMining>> {
  const header = { ...template.header };
  for (let nonce = 0n; nonce < 100_000n; nonce++) {
    header.nonce = nonce;
    if (isMiningCandidate(header, nonce)) {
      return { header, transactions: template.transactions };
    }
  }
  throw new Error("no PoW nonce found (difficulty sanity)");
}

test("chain: accepts a validated mined block; coinbase reward + supply conservation", () => {
  const { chain, mempool, miner } = fundedChain();
  const genesisSupply = chain.tipState.totalSupply();
  const receipt = mineAndSubmit(chain, mempool, miner.address, Math.floor(1_700_000_000) + 5);
  assert.equal(receipt.accepted, true, receipt.reason);
  assert.equal(chain.tip.number, 1);
  assert.equal(chain.tipState.totalSupply(), genesisSupply + BLOCK_REWARD);
});

test("chain: rejects tampered blocks (txRoot mismatch, orphan, stale timestamp)", () => {
  const { chain, mempool, miner } = fundedChain();
  const tip = chain.tip;
  // Orphan block (unknown parent)
  const orphan = { ...tip.block, header: { ...tip.block.header, parentHash: "0x" + "10".repeat(32) } };
  assert.equal(chain.acceptBlock(orphan).accepted, false);
  // Stale timestamp (same as parent's)
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: miner.address,
    timestamp: tip.block.header.timestamp,
    activeReward: BLOCK_REWARD,
    extraData: new TextEncoder().encode("stale"),
  });
  assert.equal(template, null);
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
  for (let nonce = 0n; nonce < 100_000n; nonce++) {
    header.nonce = nonce;
    if (isMiningCandidate(header, nonce)) {
      const receipt = chain.acceptBlock({ header, transactions: template.transactions });
      assert.equal(receipt.accepted, false);
      assert.match(receipt.reason ?? "", /transactionsRoot/);
      return;
    }
  }
  assert.fail("expected a nonce for difficulty 1");
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
  void txHash;
});
