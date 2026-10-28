/**
 * Issuance (block subsidy) schedule framework.
 *
 * The PRODUCTION reward schedule is intentionally UNDECIDED: neither the
 * initial reward nor the halving interval may be invented here (task rule;
 * decision D-1 open). This module therefore provides:
 *   1. a validated configuration interface (IssuanceSchedule) with an
 *      explicit UNCONFIGURED state,
 *   2. deterministic integer reward arithmetic (halving by exact bit shift
 *      on smallest-unit BigInts — no floats), including natural zero-reward
 *      tails, and
 *   3. a hard supply-cap clamp (cappedReward) so cumulative minted rewards
 *      can never exceed MAX_TOTAL_SUPPLY at any height.
 *
 * What stays ACTIVE for dev chains until the schedule decision: the fixed
 * dev default BLOCK_REWARD (src/config/params.ts — 2 BIC/block, no halving),
 * applied per block together with cappedReward. Transaction fees are NOT
 * minted supply: they move value from senders to the coinbase within the
 * state (src/tx/execute.ts), so totalSupply changes only by minted subsidies.
 */
import { MAX_TOTAL_SUPPLY } from "../config/params.js";

/**
 * Configurable issuance schedule. Both fields deliberate: `null` means the
 * deployment has NOT decided a value (no implicit defaults). A schedule is
 * usable only when both fields are set — and then `initialReward` must be a
 * non-negative integer amount in smallest units and `halvingInterval` a
 * height step >= 1.
 */
export interface IssuanceSchedule {
  /** Subsidy per block before the first halving, in base units. */
  initialReward: bigint | null;
  /** Number of heights between halvings (reward halves at heights that are
   *  multiples of this value; height 0..interval-1 receive initialReward). */
  halvingInterval: number | null;
}

/** The explicit "not yet decided" state — scheduling is refused, no invented values. */
export const UNCONFIGURED_ISSUANCE: IssuanceSchedule = { initialReward: null, halvingInterval: null };

/**
 * Subsidy at an absolute block height for a configured schedule:
 *   reward(h) = initialReward >> floor(h / halvingInterval)
 * Deterministic integer halving; after enough halvings the subsidy reaches
 * 0 naturally (zero-reward tail). Geometric decay means the mintable total is
 * bounded by initialReward * (2 * halvingInterval) — capped anyway by
 * cappedReward at every height, so the 16M BIC cap holds regardless.
 */
export function scheduleRewardAt(
  schedule: IssuanceSchedule,
  height: number,
): bigint {
  if (schedule.initialReward === null || schedule.halvingInterval === null) {
    throw new Error(
      "issuance schedule is unconfigured: initial reward and halving interval " +
        "are pending decisions (D-1) and must not be defaulted",
    );
  }
  if (schedule.halvingInterval < 1) {
    throw new Error("issuance schedule halving interval must be >= 1");
  }
  if (schedule.initialReward < 0n) {
    throw new Error("issuance schedule initial reward must be non-negative");
  }
  if (!Number.isInteger(height) || height < 0) {
    throw new Error("issuance height must be a non-negative integer");
  }
  const halvings = BigInt(Math.floor(height / schedule.halvingInterval));
  return schedule.initialReward >> halvings; // exact integer halving (floor)
}

/**
 * Supply-cap clamp for any scheduled/dev subsidy: reward = min(subsidy,
 * MAX_TOTAL_SUPPLY - mintedSoFar). With mintedSoFar >= cap the subsidy is 0
 * (zero-reward tail); within one subsidy of the cap the final block mints the
 * exact remainder; above-sum schedules can never push minted supply past the
 * cap. Pure integer arithmetic.
 */
export function cappedReward(
  subsidy: bigint,
  mintedSoFar: bigint,
  supplyCap: bigint = MAX_TOTAL_SUPPLY,
): bigint {
  if (subsidy < 0n) throw new Error("subsidy must be non-negative");
  if (mintedSoFar < 0n) throw new Error("minted supply must be non-negative");
  const remaining = supplyCap - mintedSoFar;
  if (remaining <= 0n) return 0n;
  return subsidy < remaining ? subsidy : remaining;
}
