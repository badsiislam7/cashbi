/**
 * Proof-of-Work consensus for CashBI.
 *
 * Algorithm: SHA-256 double digest over a keccak256-prehashed header view.
 *   powHash = SHA-256(SHA-256(keccak256(rlp(headerWithoutNonce)) || 8-byte BE nonce))
 * must be numerically below the target derived from difficulty:
 *   target = POW_LIMIT / difficulty
 *
 * Difficulty→target mapping (defined here, implemented identically for
 * miners and validators via difficultyToTarget/meetsTarget — no Bitcoin
 * compact-bits transplant): the digest is interpreted as a big-endian
 * unsigned integer (most significant byte first) and compared with `<=`
 * against target. Difficulty 1.0 (the initial/genesis difficulty) maps to
 * target = POW_LIMIT, the Bitcoin mainnet difficulty-1 limit (compact target
 * 0x1d00ffff), so difficulty 1 requires real proof of work rather than
 * accepting every digest. Higher difficulty linearly halves the accepted
 * interval of digests.
 * Keccak-256 remains the state/EVM hash and is used to prehash the header
 * view before the SHA-256 double-digest PoW operation.
 *
 * The ceiling keeps CPU mining viable on devnets; production parameters are
 * an open decision recorded in UNRESOLVED_DECISIONS.md.
 */

/**
 * Bounded median-anchored difficulty adjustment (task-approved targets;
 * decisions D-5/D-8 still track exact production values). Retargets happen
 * only at heights h with h % DIFFICULTY_RETARGET_INTERVAL === 0, using two
 * inclusive 10-timestamp samples taken from the branch being evaluated,
 * spaced exactly one retarget interval apart:
 *
 *   old sample: heights [h - INTERVAL - 9, h - INTERVAL]  (10 timestamps)
 *   new sample: heights [h - 9, h]                        (10 timestamps; h included)
 *
 * The lower median is the fifth-smallest timestamp (sorted index 4); the two
 * medians sit exactly DIFFICULTY_RETARGET_INTERVAL heights apart, so the
 * expected elapsed is TARGET_BLOCK_TIME_SECONDS * DIFFICULTY_RETARGET_INTERVAL
 * (= 1536 × 600 = 921,600 s with the approved targets). The new difficulty
 * takes effect at the retargeting block h itself (height h validates against
 * it; the next interval until h + 1536).
 *
 *   elapsed = lowerMedian(new) - lowerMedian(old)          // >= 0 by stamp rules
 *   e'      = clamp(elapsed, expected/4, 4*expected)       // per-retarget bounds
 *   next    = clamp((parentDifficulty * expected) / e', MIN_DIFFICULTY, MAX_DIFFICULTY)
 *
 * With this division, e' = expected/4 raises difficulty by EXACTLY 4x and
 * e' = 4*expected lowers it to EXACTLY one quarter — the approved per-retarget
 * adjustment bounds. All difficulty arithmetic is exact integer math (BigInt
 * floor division); no floating point or rounding enters consensus, so every
 * node obtains the same result from the same inputs. Side branches sample
 * their OWN branch timestamps; missing anchor history is a hard, deterministic
 * error (see nextDifficulty's callback contract). Equal timestamps across a
 * whole window yield the lower bound (difficulty rises to the 4x cap).
 * Integer overflow cannot occur: difficulty ≤ 2^32-1 and timestamps are
 * Unix seconds (double precision < 2^53 seconds), so products live in BigInt.
 *
 * First-retarget bootstrap: at h = 1536 the old sample refers to heights
 * -9..-1536 which do not exist. Those are NON-EXISTENT VIRTUAL ANCHORS defined
 * solely from the genesis header timestamp:
 *   VTS(x) = genesis.header.timestamp + x * TARGET_BLOCK_TIME_SECONDS
 * (see virtualAnchorTimestamp). They are never treated as blocks and play no
 * role in block validity, state execution, block lookup, or fork choice — only
 * in this timestamp difference. A steady chain (one stamp per target interval)
 * measures elapsed exactly 921,600 at h = 1536 and keeps its difficulty.
 */
import {
  DIFFICULTY_RETARGET_INTERVAL,
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  POW_LIMIT,
  TARGET_BLOCK_TIME_SECONDS,
} from "../config/params.js";
import { sha256 } from "../crypto/hash.js";
import { bigToHexBE, bytesEq, concatBytes, hexBEToBig, padLeft } from "../util/bytes.js";
import type { BlockHeader } from "../chain/block.js";
import { hashHeaderWithoutNonce } from "../chain/block.js";

export interface PowProof {
  nonce: bigint;
}

export type PowResult = { ok: true; hash: string } | { ok: false; hash: string; reason: string };

export function difficultyToTarget(difficulty: bigint): bigint {
  if (difficulty < 1n) throw new Error("difficulty must be >= 1");
  return POW_LIMIT / difficulty;
}

/** Double-SHA-256 of the header-with-nonce bytes (the "mining hash"). */
export function powHash(header: BlockHeader, nonce: bigint): Uint8Array {
  const inner = hashHeaderWithoutNonce(header);
  const nonceBytes = bigToHexBE(nonce & 0xffffffffffffffffn, 8); // 8-byte BE
  const innerHash = sha256(concatBytes(inner, nonceBytes));
  return sha256(innerHash);
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

/** Heights relative to a retarget height h occupied by the anchor samples.
 *  Sample width is fixed (10 lower-median timestamps); the old sample is
 *  shifted back by exactly DIFFICULTY_RETARGET_INTERVAL from the new one. */
const NEW_SAMPLE_FIRST_OFFSET = -9; // h - 9
const NEW_SAMPLE_LAST_OFFSET = 0; // h (the retarget block itself)
const SAMPLE_SIZE = 10; // both are 10-timestamp samples (inclusive endpoints)

const EXPECTED_ELAPSED = DIFFICULTY_RETARGET_INTERVAL * TARGET_BLOCK_TIME_SECONDS; // 1536 × 600 = 921,600 s
const ELAPSED_CLAMP_LOW = EXPECTED_ELAPSED / 4; // 230,400 → rises difficulty by EXACTLY 4x
const ELAPSED_CLAMP_HIGH = EXPECTED_ELAPSED * 4; // 3,686,400 → falls to EXACTLY one quarter

/** Oldest anchor height touched by a retarget at h: h - (INTERVAL + 9).
 *  Shared with the branch-walk implementations so template building and
 *  validation can never disagree about anchor depth. */
export const RETARGET_OLDEST_ANCHOR_OFFSET = DIFFICULTY_RETARGET_INTERVAL + (-NEW_SAMPLE_FIRST_OFFSET);

/**
 * Deterministic virtual-anchor timestamp for the first retarget (heights < 0),
 * derived solely from the genesis header timestamp: one synthetic TARGET
 * interval per height so that a steady honest chain measures the expected
 * elapsed. Not a real block; used only inside retarget anchor samples.
 * Undefined behavior for h >= 0 — callers must use real branch data there.
 */
export function virtualAnchorTimestamp(height: number, genesisTimestamp: number): number {
  return genesisTimestamp + height * TARGET_BLOCK_TIME_SECONDS;
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
  for (let height = h - RETARGET_OLDEST_ANCHOR_OFFSET; height <= h - DIFFICULTY_RETARGET_INTERVAL; height++) {
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
