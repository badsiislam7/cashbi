/**
 * Block header and body definitions plus canonical serialization.
 *
 * Header hash: keccak256(keccak256(rlp(headerWithoutNonce)) || 8-byte nonce).
 * This makes the nonce part of the PoW domain without re-encoding the header
 * repeatedly inside the mining loop.
 */
import { keccak256, keccak256Hex } from "../crypto/hash.js";
import { RLP, type RLPItem } from "../rlp/rlp.js";
import { bigToHexBE, bytesToUtf8, concatBytes, fromHex, toHex } from "../util/bytes.js";
import type { Transaction } from "../tx/transaction.js";
import { encodeSignedTransaction, txHash } from "../tx/transaction.js";

export interface BlockHeader {
  /** Hash of the parent header (0x + 64 hex). null for genesis parentHash="0x". */
  parentHash: string;
  number: number;
  /** Unix seconds (integer). */
  timestamp: number;
  difficulty: bigint;
  /** Coinbase / fee recipient address ("0x..."). */
  coinbase: string;
  extraData: Uint8Array;
  gasLimit: bigint;
  gasUsed: bigint;
  /** keccak of canonical serialized transactions (dev simplification, D-14). */
  transactionsRoot: string;
  /** State root AFTER executing this block (dev JSON-root, D-14). */
  stateRoot: string;
  /** 8-byte integer, serialized as hex for transport. */
  nonce: bigint;
}

export interface Block {
  header: BlockHeader;
  transactions: Transaction[];
}

export function headerWithoutNonce(header: BlockHeader): Omit<BlockHeader, "nonce"> {
  const { nonce: _nonce, ...rest } = header;
  return rest;
}

function headerFieldsForRLP(header: Omit<BlockHeader, "nonce">): RLPItem[] {
  return [
    fromHex(header.parentHash),
    RLP.fromUint(header.number),
    RLP.fromUint(Math.floor(header.timestamp)),
    RLP.fromUint(header.difficulty),
    fromHex(header.coinbase),
    header.extraData,
    RLP.fromUint(header.gasLimit),
    RLP.fromUint(header.gasUsed),
    fromHex(header.transactionsRoot),
    fromHex(header.stateRoot),
  ];
}

export function encodeHeaderView(header: Omit<BlockHeader, "nonce">): Uint8Array {
  return RLP.encode(headerFieldsForRLP(header));
}

export function hashHeaderWithoutNonce(header: Omit<BlockHeader, "nonce">): Uint8Array {
  return keccak256(encodeHeaderView(header));
}

export function blockHash(header: BlockHeader): string {
  return keccak256Hex(concatBytes(hashHeaderWithoutNonce(header), bigToHexBE(header.nonce & 0xffffffffffffffffn, 8)));
}

/** Transactions root: keccak(rlp([keccak(rlp(tx)), ...])) — dev simplification. */
export function transactionsRoot(transactions: Transaction[]): string {
  const txHashes = transactions.map((tx) => fromHex(txHash(tx)));
  return keccak256Hex(RLP.encode(txHashes));
}

export function encodeBlock(block: Block): Uint8Array {
  return RLP.encode([
    headerFieldsForRLP(headerWithoutNonce(block.header)),
    RLP.fromUint(block.header.nonce),
    block.transactions.map((tx) => encodeSignedTransaction(tx)) as RLPItem,
  ]);
}

export function decodeBlock(bytes: Uint8Array): Block {
  const outer = RLP.decode(bytes) as RLPItem[];
  if (!Array.isArray(outer) || outer.length !== 3) {
    throw new Error("malformed block encoding: expected [header, nonce, txs]");
  }
  const headerFields = outer[0] as RLPItem[];
  if (!Array.isArray(headerFields) || headerFields.length !== 10) {
    throw new Error("malformed block header encoding");
  }
  const parentHash = toHex(headerFields[0] as Uint8Array);
  const number = Number(RLP.toUint(headerFields[1] as Uint8Array));
  const timestamp = Number(RLP.toUint(headerFields[2] as Uint8Array));
  const difficulty = RLP.toUint(headerFields[3] as Uint8Array);
  const coinbase = toHex(headerFields[4] as Uint8Array);
  const extraData = headerFields[5] as Uint8Array;
  const gasLimit = RLP.toUint(headerFields[6] as Uint8Array);
  const gasUsed = RLP.toUint(headerFields[7] as Uint8Array);
  const transactionsRootHex = toHex(headerFields[8] as Uint8Array);
  const stateRootHex = toHex(headerFields[9] as Uint8Array);
  const nonce = RLP.toUint(outer[1] as Uint8Array);
  const txEncodings = outer[2] as RLPItem[];
  if (!Array.isArray(txEncodings)) throw new Error("malformed block tx encoding");
  const transactions = txEncodings.map((enc) => txModule.decodeSignedTransaction(enc as Uint8Array));
  const header: BlockHeader = {
    parentHash,
    number,
    timestamp,
    difficulty,
    coinbase,
    extraData,
    gasLimit,
    gasUsed,
    transactionsRoot: transactionsRootHex,
    stateRoot: stateRootHex,
    nonce,
  };
  return { header, transactions };
}

import * as txModule from "../tx/transaction.js";

export function extraDataToText(block: Block): string {
  return bytesToUtf8(block.header.extraData);
}
