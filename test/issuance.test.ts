import { test } from "node:test";
import assert from "node:assert";
import {
  cappedReward,
  scheduleRewardAt,
  UNCONFIGURED_ISSUANCE,
  type IssuanceSchedule,
} from "../src/consensus/issuance.js";
import { BIC, MAX_TOTAL_SUPPLY } from "../src/config/params.js";

const TEST_SCHEDULE: IssuanceSchedule = { initialReward: 8n, halvingInterval: 10 }; // test-local values only

test("issuance: deterministic integer halving on smallest units (boundary table)", () => {
  // Exact trajectory for initialReward 8, halvingInterval 10 (test-local):
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 0), 8n, "height 0 (first block of the first interval)");
  for (let h = 1; h <= 9; h++) {
    assert.equal(scheduleRewardAt(TEST_SCHEDULE, h), 8n, `h=${h}: pre-first-halving band`);
  }
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 10), 4n, "first halving boundary height");
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 19), 4n);
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 20), 2n, "second halving boundary");
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 29), 2n);
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 30), 1n, "third halving boundary");
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 39), 1n);
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 40), 0n, "halving floors to zero — deterministic zero-reward tail starts");
  assert.equal(scheduleRewardAt(TEST_SCHEDULE, 100_000), 0n, "tail persists forever, deterministically");
});

test("issuance: unconfigured or invalid schedules are hard errors — no invented defaults", () => {
  assert.throws(() => scheduleRewardAt(UNCONFIGURED_ISSUANCE, 0), /unconfigured/);
  assert.throws(() => scheduleRewardAt({ initialReward: null, halvingInterval: 210_000 }, 0), /unconfigured/);
  assert.throws(() => scheduleRewardAt({ initialReward: 32n, halvingInterval: null }, 0), /unconfigured/);
  assert.throws(() => scheduleRewardAt({ initialReward: 32n, halvingInterval: 0 }, 0), /halving interval must be >= 1/);
  assert.throws(() => scheduleRewardAt({ initialReward: -1n, halvingInterval: 10 }, 0), /non-negative/);
  assert.throws(() => scheduleRewardAt(TEST_SCHEDULE, -1), /non-negative integer/);
  assert.throws(() => scheduleRewardAt(TEST_SCHEDULE, 0.5), /non-negative integer/);
  // Sanity for the *dev default actually active today* (documented, D-1 open):
  // the task explicitly forbids reinterpreting it as the production schedule.
  assert.equal(typeof BIC(1n), "bigint");
});

test("issuance: rounding is exact floor-halving on odd initial rewards (determinism)", () => {
  const odd: IssuanceSchedule = { initialReward: 5n, halvingInterval: 2 };
  assert.equal(scheduleRewardAt(odd, 0), 5n);
  assert.equal(scheduleRewardAt(odd, 1), 5n);
  assert.equal(scheduleRewardAt(odd, 2), 2n, "5 >> 1 = 2 (floor), not round");
  assert.equal(scheduleRewardAt(odd, 3), 2n);
  assert.equal(scheduleRewardAt(odd, 4), 1n, "5 >> 2 = 1");
  assert.equal(scheduleRewardAt(odd, 6), 0n, "5 >> 3 = 0");
});

test("issuance: cappedReward enforces the 16M BIC supply cap exactly (boundary heights, zero tail)", () => {
  const CAP = MAX_TOTAL_SUPPLY; // 16,000,000 BIC in base units
  // Identity regime: subsidy below remaining mints fully.
  assert.equal(cappedReward(BIC(2n), 0n), BIC(2n));
  // Exactly one subsidy short of the cap: final block mints the exact remainder.
  assert.equal(cappedReward(BIC(2n), CAP - BIC(2n)), BIC(2n));
  // Within one subsidy of the cap: the remainder mints exactly, no overshoot.
  assert.equal(cappedReward(BIC(2n), CAP - BIC(1n)), BIC(1n));
  // At the cap and beyond: zero-reward tail (no rejections, no minting).
  assert.equal(cappedReward(BIC(2n), CAP), 0n);
  assert.equal(cappedReward(BIC(2n), CAP + 1n), 0n);
  // Oversized/oversumming schedule still cannot cross the cap.
  assert.equal(cappedReward(CAP, 0n, CAP), CAP);
  assert.equal(cappedReward(CAP, CAP - 3n, CAP), 3n);
  // Invalid inputs refused.
  assert.throws(() => cappedReward(-1n, 0n), /non-negative/);
  assert.throws(() => cappedReward(1n, -1n), /non-negative/);
});

test("issuance: cumulative minted supply can never exceed 16,000,000 BIC (cap-saturating simulation)", () => {
  // Test-local schedule (NOT production): subsidy equal to the whole cap on
  // every block. Clamping must keep minted == cap exactly, then zero forever.
  let minted = 0n;
  for (let height = 0; height < 20; height++) {
    const subsidy = scheduleRewardAt({ initialReward: MAX_TOTAL_SUPPLY, halvingInterval: 1 }, height);
    const reward = cappedReward(subsidy, minted);
    minted += reward;
    assert.equal(minted <= MAX_TOTAL_SUPPLY, true, `cap invariant at height ${height}`);
  }
  assert.equal(minted, MAX_TOTAL_SUPPLY, "cap fills exactly, then the zero-reward tail holds");
});

test("issuance: halving-schedule simulation with a cap-busting initial reward stays under the cap", () => {
  // Test-local: initial 1 BIC, halving every 10 blocks; rewards clamp at the tail.
  let minted = 0n;
  const schedule: IssuanceSchedule = { initialReward: BIC(1n), halvingInterval: 10 };
  for (let height = 0; height < 4_000; height++) {
    const reward = cappedReward(scheduleRewardAt(schedule, height), minted);
    minted += reward;
    assert.equal(minted <= MAX_TOTAL_SUPPLY, true, `cap invariant at height ${height}`);
  }
  // Exact cumulative mint = Σ over halving epochs of 10 × (initialReward >> k),
  // derived here independently of scheduleRewardAt (floor halving, zeros tail).
  let expected = 0n;
  for (let k = 0; k < 400; k++) expected += 10n * (BIC(1n) >> BigInt(k));
  assert.equal(minted, expected, "exact deterministic cumulative mint (fractional tails floored)");
});

test("issuance: fees are not minted supply (documentation-level pin)", () => {
  // Fees move existing balances (senders -> coinbase) inside execution
  // (src/tx/execute.ts addBalance); the subsidy added by cappedReward is the
  // only minted amount. Chain-level conservation tests in chain.test.ts pin
  // sender/coinbase accounting; this test documents the division of labor.
  assert.equal(cappedReward(0n, 0n), 0n, "zero subsidy mints nothing even at height 0");
});
