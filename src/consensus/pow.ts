/**
 * Proof-of-Work consensus for CashBI.
 *
 * Algorithm: keccak256(keccak256(rlp(headerWithoutNonce)) || 8-byte BE nonce)
 * must be numerically below the target derived from difficulty:
 *   target = MAX_UINT256 / difficulty
 *
 * Difficulty adjustment is a bounded linear correction applied every
 * DIFFICULTY_RETARGET_INTERVAL blocks (dev default; see decision D-5).
 * The ceiling keeps CPU mining viable on devnets; production parameters are
 * an open decision recorded in UNRESOLVED_DECISIONS.md.
 */
import {
  DIFFICULTY_RETARGET_INTERVAL,
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  TARGET_BLOCK_TIME_SECONDS,
} from "../config/params.js";
import { keccak256 } from "../crypto/hash.js";
import { bigToHexBE, bytesEq, concatBytes, hexBEToBig, padLeft } from "../util/bytes.js";
import type { BlockHeader } from "../chain/block.js";
import { hashHeaderWithoutNonce } from "../chain/block.js";

export interface PowProof {
  nonce: bigint;
}

export type PowResult = { ok: true; hash: string } | { ok: false; hash: string; reason: string };

export function difficultyToTarget(difficulty: bigint): bigint {
  if (difficulty < 1n) throw new Error("difficulty must be >= 1");
  const one = 1n << 256n;
  return one / difficulty;
}

/** Hash of the header with the nonce bytes appended (the "mining hash"). */
export function powHash(header: BlockHeader, nonce: bigint): Uint8Array {
  const inner = hashHeaderWithoutNonce(header);
  const nonceBytes = bigToHexBE(nonce & 0xffffffffffffffffn, 8); // 8-byte BE
  return keccak256(concatBytes(inner, nonceBytes));
}

export function meetsTarget(powDigest: Uint8Array, difficulty: bigint): boolean {
  return hexBEToBig(powDigest) <= difficultyToTarget(difficulty);
}

export function verifyHeaderPoW(header: BlockHeader, proof: PowProof): PowResult {
  const digest = powHash(header, proof.nonce);
  if (!meetsTarget(digest, header.difficulty)) {
    return { ok: false, hash: "0x", reason: `PoW hash above target (difficulty ${header.difficulty})` };
  }
  return { ok: true, hash: "" };
}

/**
 * Bounded linear difficulty adjustment (dev default D-5).
 * Called at retarget heights only:
 *   expected = TARGET_BLOCK_TIME * interval
 *   delta = clamp(elapsed / expected, 1/4, 4)
 *   next = clamp(difficulty * delta, MIN_DIFFICULTY, MAX_DIFFICULTY)
 */
export function retargetDifficulty(
  currentDifficulty: bigint,
  elapsedSeconds: number,
  interval: number = DIFFICULTY_RETARGET_INTERVAL,
  blockTimeSeconds: number = TARGET_BLOCK_TIME_SECONDS,
): bigint {
  if (interval < 1) throw new Error("retarget interval must be >= 1");
  if (elapsedSeconds <= 0) return clamp(currentDifficulty);
  const expected = interval * blockTimeSeconds;
  // Blocks arriving too fast (elapsed < expected) must INCREASE difficulty.
  const multiplier = elapsedSeconds / expected; // <1 fast, >1 slow
  const clampedMultiplier = Math.min(4.0, Math.max(0.25, multiplier));
  const next = (currentDifficulty * 100n) / BigInt(Math.max(1, Math.round(clampedMultiplier * 100)));
  if (next < 1n) return 1n;
  return clamp(next);
}

function clamp(difficulty: bigint): bigint {
  if (difficulty < BigInt(MIN_DIFFICULTY)) return BigInt(MIN_DIFFICULTY);
  if (difficulty > BigInt(MAX_DIFFICULTY)) return BigInt(MAX_DIFFICULTY);
  return difficulty;
}

/** Difficulty for a new block at `nextHeight`, given the parent's context. */
export function nextDifficulty(
  parentDifficulty: bigint,
  parentHeight: number,
  parentTimestamp: number,
  nextTimestamp: number,
): bigint {
  const nextHeight = parentHeight + 1;
  if (nextHeight % DIFFICULTY_RETARGET_INTERVAL !== 0) return parentDifficulty;
  const elapsed = Math.max(0, nextTimestamp - parentTimestamp);
  return retargetDifficulty(parentDifficulty, elapsed);
}

/** Convenience for the miner: check once per candidate. */
export function isMiningCandidate(header: BlockHeader, nonce: bigint): boolean {
  return meetsTarget(powHash(header, nonce), header.difficulty);
}

export { bytesEq, padLeft };
