/**
 * Proof-of-Work consensus for CashBI.
 *
 * Algorithm: keccak256(keccak256(rlp(headerWithoutNonce)) || 8-byte BE nonce)
 * must be numerically below the target derived from difficulty:
 *   target = MAX_UINT256 / difficulty
 *
 * The ceiling keeps CPU mining viable on devnets; production parameters are
 * an open decision recorded in UNRESOLVED_DECISIONS.md.
 */

/**
 * Bounded median-anchored difficulty adjustment (dev defaults; decisions
 * D-5/D-8 open). Retargets happen only at heights h with
 * h % DIFFICULTY_RETARGET_INTERVAL === 0, using two inclusive 10-timestamp
 * samples taken from the branch being evaluated:
 *
 *   old sample: heights [h - 69, h - 60]  (10 timestamps)
 *   new sample: heights [h - 9, h]        (10 timestamps; includes h itself)
 *
 * The lower median is the fifth-smallest timestamp (sorted index 4); the two
 * medians sit exactly DIFFICULTY_RETARGET_INTERVAL heights apart, so the
 * expected elapsed is TARGET_BLOCK_TIME_SECONDS * DIFFICULTY_RETARGET_INTERVAL.
 *
 *   elapsed = lowerMedian(new) - lowerMedian(old)          // >= 0 by stamp rules
 *   e'      = clamp(elapsed, 15, 240)                      // [expected/4, 4*expected]
 *   next    = clamp((parentDifficulty * expected) / e', MIN_DIFFICULTY, MAX_DIFFICULTY)
 *
 * All difficulty arithmetic is exact integer math (BigInt floor division);
 * no floating point or rounding enters the consensus formula. The height
 * offsets below assume DIFFICULTY_RETARGET_INTERVAL = 60 (approved Phase 1
 * parameter); changing the interval is an open decision (D-5) and requires
 * redesigning the sample offsets, not just the constant.
 *
 * First-retarget bootstrap (approved design): the old sample at h = 60 refers
 * to heights -9..-1 which do not exist. Those are DETERMINISTIC VIRTUAL
 * ANCHORS defined solely from the genesis header timestamp:
 * VTS(x) = genesis.header.timestamp + x (see virtualAnchorTimestamp). They are
 * never treated as blocks and play no role in block validity, state
 * execution, block lookup, or fork choice — only in this timestamp
 * difference. A steady 1 s/block chain yields elapsed exactly 60 at h = 60.
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

/** Heights relative to a retarget height h occupied by the anchor samples. */
const OLD_SAMPLE_FIRST_OFFSET = -69; // h - 69 (oldest)
const OLD_SAMPLE_LAST_OFFSET = -60; // h - 60 (newest of the old sample)
const NEW_SAMPLE_FIRST_OFFSET = -9; // h - 9
const NEW_SAMPLE_LAST_OFFSET = 0; // h (the retarget block itself)
const SAMPLE_SIZE = 10; // both are 10-timestamp samples (inclusive endpoints)

const EXPECTED_ELAPSED = DIFFICULTY_RETARGET_INTERVAL * TARGET_BLOCK_TIME_SECONDS; // 60 with dev defaults
const ELAPSED_CLAMP_LOW = 15; // floor(EXPECTED_ELAPSED / 4) = expected/4 lower bound
const ELAPSED_CLAMP_HIGH = 240; // 4 * EXPECTED_ELAPSED = expected*4 upper bound

/**
 * Deterministic virtual-anchor timestamp for the first retarget (heights < 0),
 * derived solely from the genesis header timestamp. Not a real block; used
 * only inside retarget anchor samples. Undefined behavior for h >= 0 — callers
 * must use real branch data there.
 */
export function virtualAnchorTimestamp(height: number, genesisTimestamp: number): number {
  return genesisTimestamp + height;
}

/** Lower median of a retarget sample: fifth-smallest of 10 (sorted index 4). */
export function lowerMedian(values: number[]): number {
  if (values.length !== SAMPLE_SIZE) {
    throw new Error(`retarget sample must contain exactly ${SAMPLE_SIZE} timestamps`);
  }
  const sorted = [...values].sort((a, b) => a - b); // integer-second timestamps: exact numeric sort
  return sorted[SAMPLE_SIZE / 2 - 1];
}

/**
 * Bounded integer difficulty adjustment from a raw elapsed measurement.
 * Clamps the elapsed into [ELAPSED_CLAMP_LOW, ELAPSED_CLAMP_HIGH] BEFORE the
 * division, then applies exact BigInt floor division and bounds clamping.
 */
export function retargetDifficulty(parentDifficulty: bigint, elapsedSeconds: number): bigint {
  if (!Number.isInteger(elapsedSeconds)) {
    throw new Error("elapsed seconds must be an integer (no float consensus values)");
  }
  let elapsed = elapsedSeconds;
  if (elapsed < ELAPSED_CLAMP_LOW) elapsed = ELAPSED_CLAMP_LOW;
  if (elapsed > ELAPSED_CLAMP_HIGH) elapsed = ELAPSED_CLAMP_HIGH;
  return clampDifficulty((parentDifficulty * BigInt(EXPECTED_ELAPSED)) / BigInt(elapsed));
}

/** The retarget only samples timestamps of the branch being evaluated. If a
 *  needed height has no block on that branch (pruning/reorg edge), the
 *  callback must throw; callers convert that into a deterministic rejection. */
export function nextDifficulty(
  parentDifficulty: bigint,
  parentHeight: number,
  nextTimestamp: number,
  timestampAt: (height: number) => number,
): bigint {
  const retargetHeight = parentHeight + 1;
  if (retargetHeight % DIFFICULTY_RETARGET_INTERVAL !== 0) return parentDifficulty;
  const h = retargetHeight;
  const oldSample: number[] = [];
  for (let height = h + OLD_SAMPLE_FIRST_OFFSET; height <= h + OLD_SAMPLE_LAST_OFFSET; height++) {
    oldSample.push(timestampAt(height));
  }
  const newSample: number[] = [];
  for (let height = h + NEW_SAMPLE_FIRST_OFFSET; height <= h + NEW_SAMPLE_LAST_OFFSET; height++) {
    newSample.push(height === h ? nextTimestamp : timestampAt(height));
  }
  return retargetDifficulty(parentDifficulty, lowerMedian(newSample) - lowerMedian(oldSample));
}

function clampDifficulty(difficulty: bigint): bigint {
  if (difficulty < BigInt(MIN_DIFFICULTY)) return BigInt(MIN_DIFFICULTY);
  if (difficulty > BigInt(MAX_DIFFICULTY)) return BigInt(MAX_DIFFICULTY);
  return difficulty;
}

/** Convenience for the miner: check once per candidate. */
export function isMiningCandidate(header: BlockHeader, nonce: bigint): boolean {
  return meetsTarget(powHash(header, nonce), header.difficulty);
}

export { bytesEq, padLeft };
