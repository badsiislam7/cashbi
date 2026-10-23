/**
 * Development smoke script: exercises keys → tx → EVM → block → chain → mempool.
 * Run with: node --import tsx scripts/smoke.ts
 */
import { randomAccount, signTransaction, decodeSignedTransaction, encodeSignedTransaction, recoverTransactionSender, txHash } from "../src/tx/transaction.js";
import { signMessage, verifySignature } from "../src/crypto/keys.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Blockchain } from "../src/chain/blockchain.js";
import { emptyGenesisConfig } from "../src/chain/genesis.js";
import { buildBlockForMining } from "../src/mining/candidate.js";
import { Miner } from "../src/mining/miner.js";
import { Mempool } from "../src/tx/mempool.js";
import { BIC, DEV_CHAIN_ID } from "../src/config/params.js";
import { randomBytes32 } from "../src/crypto/hash.js";

const { address: minerAddr } = randomAccount();
const { address: userAddr, privateKey: userPriv } = randomAccount();

// 1. Crypto roundtrip
const msg = randomBytes32();
const sig = signMessage(msg, userPriv);
const userPub = secp256k1.getPublicKey(userPriv, false);
if (!verifySignature(msg, sig, Buffer.from(userPub).toString("hex"))) throw new Error("verifySignature failed");
console.log("crypto ok");

// 2. Genesis with allocations
const genesis = emptyGenesisConfig(1_700_000_000);
genesis.allocations = [
  { address: userAddr, balance: BIC(1000n) },
  { address: minerAddr, balance: 0n },
];
const chain = new Blockchain(genesis);
console.log("genesis hash", chain.genesis.genesisHash, "tip", chain.tip.number);

const state0 = chain.tipState;
console.log("balances", state0.getAccount(userAddr)!.balance, state0.getAccount(minerAddr)!.balance);

// 3. Transfer tx
const tx = signTransaction({
  nonce: 0n,
  to: minerAddr,
  value: BIC(2n),
  data: new Uint8Array(0),
  gasPrice: 1n,
  gas: 30000n,
  chainId: DEV_CHAIN_ID,
}, userPriv);
const raw = encodeSignedTransaction(tx);
const dec = decodeSignedTransaction(raw);
console.log("tx roundtrip", txHash(tx) === txHash(dec), "sender", recoverTransactionSender(dec, DEV_CHAIN_ID) === userAddr);

// Inject into genesis balance check via mempool
const mempool = new Mempool();
const added = mempool.add(dec, { chainId: DEV_CHAIN_ID, state: state0 });
console.log("mempool added:", added);

// 4. Mining a block containing the tx (consent needed)
const miner = new Miner(chain, mempool, { coinbase: minerAddr, hashRatePerSecond: 1024 });
miner.grantConsent("cli-flag");
const candidate0 = buildBlockForMining({ chain, mempool, coinbase: minerAddr, timestamp: Math.floor(Date.now() / 1000) + 2, activeReward: 2n * BIC(1n), extraData: new Uint8Array(0) });
console.log("candidate built", candidate0 !== null, candidate0?.transactions.length);
if (!candidate0) throw new Error("no candidate");

// find nonce quickly (difficulty=1 => ~1/2^256 chance? NO: target = 2^256/1 = 2^256 => any hash ≤ target, i.e. always)
console.log(chain.acceptBlock(candidate0));
const tip1 = chain.tip;
console.log("tip1", tip1.number, tip1.hash, mempool.stats());
const u = chain.tipState.getAccount(userAddr)!.balance;
const m = chain.tipState.getAccount(minerAddr)!.balance;
console.log("balances after block", u, m);

// 5. Fork/reorg: create a competing block at height 1 with a bigger gas price
console.log("done");
