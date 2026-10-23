/**
 * CashBI "legacy" transactions with EIP-155-style replay protection.
 *
 * Field order (canonical signing payload):
 *   [nonce, to, value, data, gasPrice, gas, chainId, 0, 0]
 *   - `to` is the 20-byte address for calls, null (empty) for contract creation.
 *   - v = recoveryId + 35 + 2 * chainId (EIP-155).
 */
import { keccak256 } from "../crypto/hash.js";
import {
  signMessage,
  addressFromPrivateKey,
  recoverAddress,
} from "../crypto/keys.js";
import { RLP, type RLPItem } from "../rlp/rlp.js";
import { MAX_TX_BYTES, } from "../config/params.js";
import {
  fromHex,
  hexBEToBig,
  isHex,
  padLeft,
  toHex,
  type Bytes,
} from "../util/bytes.js";

export interface TransactionBody {
  nonce: bigint;
  /** Recipient address ("0x..." 20 bytes) or null for contract creation. */
  to: string | null;
  value: bigint;
  data: Uint8Array;
  gasPrice: bigint;
  gas: bigint;
  /** Ignored in signing payload (written to rlp with rec id) */
  chainId: number;
}

export interface Transaction extends TransactionBody {
  v: number; // EIP-155: rec_id + 35 + 2 * chainId
  r: string;
  s: string;
}

export interface SignedTransaction extends Transaction {
  from: string; // recovered sender; populated after validation
}

export function emptyTransactionBody(): TransactionBody {
  return {
    nonce: 0n,
    to: null,
    value: 0n,
    data: new Uint8Array(0),
    gasPrice: 0n,
    gas: 0n,
    chainId: 0,
  };
}

function bodyToRLPTuple(body: TransactionBody, chainId: number, forSigning: boolean): RLPItem[] {
  const tuple: RLPItem[] = [
    RLP.fromUint(body.nonce),
    body.to ? fromHex(body.to) : new Uint8Array(0),
    RLP.fromUint(body.value),
    body.data,
    RLP.fromUint(body.gasPrice),
    RLP.fromUint(body.gas),
  ];
  if (forSigning) {
    tuple.push(RLP.fromUint(chainId), new Uint8Array(0), new Uint8Array(0));
  }
  return tuple;
}

export function encodeTransactionBody(body: TransactionBody): Uint8Array {
  return RLP.encode(bodyToRLPTuple(body, body.chainId, false));
}

/** Signing hash: keccak of the "for signing" tuple (EIP-155 style). */
export function signingHash(body: TransactionBody): Uint8Array {
  return keccak256(RLP.encode(bodyToRLPTuple(body, body.chainId, true)));
}

export function signTransaction(body: TransactionBody, privateKey: Uint8Array): Transaction {
  if (!Number.isInteger(body.chainId) || body.chainId <= 0) {
    throw new Error("chainId must be a positive integer (EIP-155 replay protection)");
  }
  const msg = signingHash(body);
  const sig = signMessage(msg, privateKey);
  const v = sig.recovery + 35 + 2 * body.chainId;
  return { ...body, v, r: sig.r, s: sig.s };
}

/** Canonical hash of the unsigned body — used for mempool identity. */

export function recoverTransactionSender(tx: Transaction, expectedChainId: number): string {
  if (tx.v < 35 + 2 * expectedChainId) {
    throw new Error("tx.v is not an EIP-155 signature for this chain");
  }
  const recId = tx.v - 35 - 2 * expectedChainId;
  if (recId !== 0 && recId !== 1) {
    throw new Error(`invalid recovery id ${recId}`);
  }
  const msg = signingHash({ ...tx });
  return recoverAddress(msg, { r: tx.r, s: tx.s, recovery: recId });
}

export function txHash(tx: Transaction): string {
  return toHex(keccak256(encodeTransactionBody(tx)));
}

/**
 * Mempool priority ordering: higher gas price first, then older nonce first.
 */
export function sortTransactions(transactions: Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => {
    if (a.gasPrice !== b.gasPrice) return a.gasPrice > b.gasPrice ? -1 : 1;
    if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1;
    return txHash(a) < txHash(b) ? -1 : 1;
  });
}

/** Canonical RLP serialization exchanged over the network and on disk. */
export function encodeSignedTransaction(tx: Transaction): Uint8Array {
  return RLP.encode([
    RLP.fromUint(tx.nonce),
    tx.to ? fromHex(tx.to) : new Uint8Array(0),
    RLP.fromUint(tx.value),
    tx.data,
    RLP.fromUint(tx.gasPrice),
    RLP.fromUint(tx.gas),
    fromHex(tx.r),
    fromHex(tx.s),
    RLP.fromUint(tx.chainId),
    RLP.fromUint(tx.v),
  ]);
}

export function decodeSignedTransaction(bytes: Uint8Array): Transaction {
  if (bytes.length > MAX_TX_BYTES) throw new Error("transaction exceeds MAX_TX_BYTES");
  const items = RLP.decode(bytes);
  if (!Array.isArray(items) || items.length !== 10) {
    throw new Error("malformed signed transaction (expected 10 fields)");
  }
  const data = items[3] instanceof Uint8Array ? items[3] : new Uint8Array(0);
  const nonce = RLP.toUint(items[0] as Uint8Array);
  const toRaw = items[1] as Uint8Array;
  const addrItem = items[1] instanceof Uint8Array && (items[1] as Uint8Array).length === 20
    ? items[1] as Uint8Array
    : null;
  const chainId = Number(RLP.toUint(items[8] as Uint8Array));
  const chainIdOk = Number.isInteger(chainId) && chainId > 0;
  if (!chainIdOk) throw new Error("invalid chainId in signed transaction");
  if (toRaw.length !== 0 && toRaw.length !== 20) {
    throw new Error("invalid recipient address length");
  }
  const tx: Transaction = {
    nonce,
    to: addrItem ? toHex(addrItem) : null,
    value: RLP.toUint(items[2] as Uint8Array),
    data,
    gasPrice: RLP.toUint(items[4] as Uint8Array),
    gas: RLP.toUint(items[5] as Uint8Array),
    r: toHex(items[6] as Uint8Array),
    s: toHex(items[7] as Uint8Array),
    chainId,
    v: Number(RLP.toUint(items[9] as Uint8Array)),
  };
  return tx;
}

export interface TxValidationContext {
  chainId: number;
  senderNonce: bigint;
  senderBalance: bigint;
}

/** Structural validation before execution. Returns the recovered sender. */
export function validateTransaction(
  tx: Transaction,
  ctx: TxValidationContext,
): { sender: string; maxSpend: bigint } {
  if (tx.chainId !== ctx.chainId) throw new Error(`tx.chainId ${tx.chainId} does not match ${ctx.chainId}`);
  if (tx.nonce < ctx.senderNonce) throw new Error("nonce too low");
  if (tx.gas <= 0n) throw new Error("gas must be positive");
  if (tx.data.length > MAX_TX_BYTES) throw new Error("tx data exceeds MAX_TX_BYTES");
  if (tx.to && !isHex(tx.to)) throw new Error("invalid recipient address");
  const maxSpend = tx.value + tx.gas * tx.gasPrice;
  if (maxSpend > ctx.senderBalance) throw new Error("insufficient balance for tx + gas");
  const sender = recoverTransactionSender(tx, ctx.chainId);
  return { sender, maxSpend };
}

export type { Bytes };

export function randomAccount(privateKey?: Uint8Array): { address: string; privateKey: Uint8Array } {
  const priv = privateKey ?? generateRandomKey();
  return { address: addressFromPrivateKey(priv), privateKey: priv };
}

function generateRandomKey(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

/** Convert 20-byte address w/ left padding to 32-byte word (for EVM ops). */
export function addressToWord(address: string): Uint8Array {
  return padLeft(fromHex(address), 32);
}

export function wordToAddress(word: Uint8Array): string {
  return toHex(word.slice(12));
}

export function readValueAsBig(item: Uint8Array): bigint {
  return hexBEToBig(item);
}
