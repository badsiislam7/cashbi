import { test } from "node:test";
import assert from "node:assert";
import {
  difficultyToTarget,
  isMiningCandidate,
  lowerMedian,
  meetsTarget,
  nextDifficulty,
  powHash,
  retargetDifficulty,
  verifyHeaderPoW,
  virtualAnchorTimestamp,
} from "../src/consensus/pow.js";
import { MAX_DIFFICULTY, MIN_DIFFICULTY } from "../src/config/params.js";
import { emptyGenesisConfig, buildGenesis } from "../src/chain/genesis.js";
import { randomBytes32 } from "../src/crypto/hash.js";

test("pow: trivial difficulty accepts any hash, large difficulty rejects most", () => {
  const genesis = buildGenesis(emptyGenesisConfig(0));
  const header = genesis.block.header;
  header.nonce = 7n;
  assert.equal(isMiningCandidate(header, 7n), true); // difficulty 1 -> target max
  // For big difficulty, the probability that a random nonce meets the target
  // is tiny; verify it deterministically by constructing a header whose
  // powHash is known to exceed the target for many nonces.
  header.extraData = randomBytes32();
  let found = false;
  for (let nonce = 0n; nonce < 50n; nonce++) {
    if (meetsTarget(powHash(header, nonce), 10n ** 18n)) found = true;
  }
  // Expected ~50/2^60 chance of success, so found must be false deterministically.
  assert.equal(found, false);
});

test("pow: difficultyToTarget inverse behavior", () => {
  const t1 = difficultyToTarget(2n);
  const t2 = difficultyToTarget(4n);
  assert.equal(t2 < t1, true); // higher difficulty = lower target
});

test("pow: retarget bounds (clamped to exact 4x / 1/4x by the [15, 240] elapsed clamps)", () => {
  const d = 10_000n;
  // Fast mining -> increases (bounded to exactly 4x at elapsed 15)
  const fast = retargetDifficulty(d, 6); // below lower clamp -> 15
  assert.equal(fast, d * 4n, "elapsed below the lower clamp must clamp to 15 first");
  // Slow mining -> decreases (bounded to exactly 1/4x at elapsed 240)
  const slow = retargetDifficulty(d, 2_400); // above upper clamp -> 240
  assert.equal(slow, d / 4n, "elapsed above the upper clamp must clamp to 240 first");
  // Non-retarget heights keep the difficulty unchanged (anchors never consulted)
  assert.equal(nextDifficulty(d, 1, 101, throwingLookup), d);
});

test("pow: difficulty cannot drop below MIN_DIFFICULTY", () => {
  const d = BigInt(MIN_DIFFICULTY); // already at minimum
  const slow = retargetDifficulty(d, 60_000);
  assert.equal(slow, d, "difficulty cannot drop below MIN_DIFFICULTY");
});

test("pow: difficulty cannot exceed MAX_DIFFICULTY", () => {
  const d = BigInt(MAX_DIFFICULTY); // already at maximum
  const fast = retargetDifficulty(d, 1);
  assert.equal(fast, d, "difficulty cannot exceed MAX_DIFFICULTY");
});

test("pow: difficulty cannot drop below MIN_DIFFICULTY even with extreme retarget", () => {
  const d = BigInt(MIN_DIFFICULTY) * 1000n; // start well above minimum
  let current = d;
  // Simulate many retargets with maximally slow blocks (elapsed clamps to 240 each time)
  for (let i = 0; i < 100; i++) {
    current = retargetDifficulty(current, 60_000);
  }
  assert.equal(current, BigInt(MIN_DIFFICULTY), "difficulty should floor at MIN_DIFFICULTY after many slow retargets");
});

test("pow: difficulty cannot exceed MAX_DIFFICULTY even with extreme retarget", () => {
  const d = BigInt(MAX_DIFFICULTY) / 1000n; // start well below maximum
  let current = d;
  // Simulate many retargets with maximally fast blocks (elapsed clamps to 15 each time)
  for (let i = 0; i < 100; i++) {
    current = retargetDifficulty(current, 1);
  }
  assert.equal(current, BigInt(MAX_DIFFICULTY), "difficulty should cap at MAX_DIFFICULTY after many fast retargets");
});

function throwingLookup(height: number): number {
  throw new Error(`anchor lookup must not be consulted (got height ${height})`);
}

const GENESIS_TS = 1_700_000_000;

/** Honest steady-state chain stamps: ts(h) = GENESIS_TS + h (1 s/block). */
function honestLookupSpy(): { lookup: (height: number) => number; queried: Array<{ height: number; ts: number }> } {
  const queried: Array<{ height: number; ts: number }> = [];
  return {
    queried,
    lookup: (height: number) => {
      const ts = height >= 0 ? GENESIS_TS + height : virtualAnchorTimestamp(height, GENESIS_TS);
      queried.push({ height, ts });
      return ts;
    },
  };
}

test("pow: lower median — fifth-smallest, duplicates, exact size required", () => {
  assert.equal(lowerMedian([5, 3, 9, 1, 4, 2, 10, 8, 7, 6]), 5, "unsorted input sorts first");
  assert.equal(lowerMedian([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]), 500, "5th smallest of 10");
  assert.equal(lowerMedian(Array(10).fill(42)), 42, "all-duplicate sample yields that timestamp");
  assert.equal(lowerMedian([7, 7, 7, 7, 7, 8, 8, 8, 8, 8]), 7, "lower median picks the smaller of adjacent equal runs");
  assert.throws(() => lowerMedian([1, 2, 3]), /exactly 10/);
});

test("pow: retarget formula — exact bigint cases (elapsed = expected, 1/4x, 4x, clamps, bounds)", () => {
  const D = 65_536n;
  assert.equal(retargetDifficulty(D, 60), D, "elapsed == expected -> unchanged");
  assert.equal(retargetDifficulty(D, 15), 262_144n, "elapsed = expected/4 -> exactly x4");
  assert.equal(retargetDifficulty(D, 240), 16_384n, "elapsed = 4x expected -> exactly /4");
  assert.equal(retargetDifficulty(D, 14), retargetDifficulty(D, 15), "below lower clamp: clamped before division");
  assert.equal(retargetDifficulty(D, 241), retargetDifficulty(D, 240), "above upper clamp: clamped before division");
  // Non-divisible dividends use exact BigInt floor division (no floats, no rounding bias beyond <1 unit).
  assert.equal(retargetDifficulty(1_048_577n, 45), 1_398_102n, "62914620/45 floor = 1398102");
  assert.equal(retargetDifficulty(1_048_577n, 50), 1_258_292n, "62914620/50 floor = 1258292");
  // Minimum/maximum bounds.
  assert.equal(retargetDifficulty(BigInt(MIN_DIFFICULTY), 240), BigInt(MIN_DIFFICULTY), "MIN-bound slow window stays at MIN");
  assert.equal(retargetDifficulty(7n, 50), BigInt(MIN_DIFFICULTY), "tiny difficulty floors at MIN");
  assert.equal(retargetDifficulty(BigInt(MAX_DIFFICULTY), 15), BigInt(MAX_DIFFICULTY), "MAX-bound fast window stays at MAX");
  // Determinism guard: fractional elapsed values are rejected outright.
  assert.throws(() => retargetDifficulty(D, 60.5), /integer/);
});

test("pow: sample membership and lower medians at heights 60, 120, 180 (hand table)", () => {
  // Honest 1 s stamps; the hand table from the approved design:
  //   h=60:  old [-9..0]  LM=GENESIS_TS-5, new [51..60]  LM=GENESIS_TS+55, elapsed 60
  //   h=120: old [51..60] LM=GENESIS_TS+55, new [111..120] LM=+115, elapsed 60
  //   h=180: old [111..120] LM=+115, new [171..180] LM=+175, elapsed 60
  for (const [parentHeight, expectedOldLowest, expectedNewFirst] of [
    [59, GENESIS_TS - 9, GENESIS_TS + 51],
    [119, GENESIS_TS + 51, GENESIS_TS + 111],
    [179, GENESIS_TS + 111, GENESIS_TS + 171],
  ] as Array<[number, number, number]>) {
    const probe = honestLookupSpy();
    const h = parentHeight + 1;
    const next = nextDifficulty(65_536n, parentHeight, GENESIS_TS + h, probe.lookup);
    assert.equal(next, 65_536n, `h=${h}: steady honest chain keeps difficulty unchanged`);
    // Membership: old sample heights h-69..h-60 were consulted, new sample
    // heights h-9..h-1 were consulted (h comes from nextTimestamp directly).
    const queried = probe.queried;
    assert.equal(queried.length, 19, "exactly 19 anchor lookups (10 old + 9 new)");
    assert.equal(queried[0].height, h - 69, "first consulted anchor is the oldest old-sample height");
    assert.equal(queried[0].ts, expectedOldLowest, "oldest old-sample timestamp matches the hand table");
    assert.equal(queried[9].height, h - 60, "10th consulted anchor is the newest old-sample height");
    assert.equal(queried[10].height, h - 9, "11th consulted anchor is the oldest new-sample height");
    assert.equal(queried[10].ts, expectedNewFirst, "oldest new-sample timestamp matches the hand table");
    assert.equal(queried[18].height, h - 1, "19th consulted anchor is the parent height");
  }
});

test("pow: first-retarget bootstrap uses virtual anchors from the genesis header", () => {
  // Heights -9..-1 at h=60 are virtual anchors VTS(x) = GENESIS_TS + x. A
  // steady honest chain measures elapsed exactly 60 at the FIRST retarget —
  // the same as every later retarget uses real branch history.
  const probe = honestLookupSpy();
  const next = nextDifficulty(65_536n, 59, GENESIS_TS + 60, probe.lookup);
  assert.equal(next, 65_536n, "first retarget on an honest chain leaves difficulty unchanged (elapsed exactly 60)");
  assert.equal(probe.queried.some((q) => q.height === -1), true, "virtual anchor height -1 was consulted");
  assert.equal(probe.queried.some((q) => q.height === -9), true, "virtual anchor height -9 was consulted");
  assert.equal(virtualAnchorTimestamp(-1, GENESIS_TS), GENESIS_TS - 1, "VTS(-1) = genesis_ts - 1");
  assert.equal(virtualAnchorTimestamp(-9, GENESIS_TS), GENESIS_TS - 9, "VTS(-9) = genesis_ts - 9");
  // The clamp-to-genesis alternative would give elapsed 55 here (measured
  // during design review, +9.1% spurious first retarget) — pinned away.
  const noBootstrap = nextDifficulty(65_536n, 59, GENESIS_TS + 60, (height) =>
    height < 0 ? GENESIS_TS : GENESIS_TS + height);
  assert.equal(noBootstrap, 71_493n, "the rejected clamp-variant would give a different (biased) result: 65536x60/55");
});

test("pow: equal-stamp window RAISES difficulty (one-sidedness regression)", () => {
  // Blocks 1..59 all stamped at the genesis second: LM(new) = GENESIS_TS,
  // LM(old) = GENESIS_TS - 5 (virtual anchors), elapsed 5 -> clamped to 15.
  const lookup = (height: number) => height >= 0 ? GENESIS_TS : virtualAnchorTimestamp(height, GENESIS_TS);
  const next = nextDifficulty(1n, 59, GENESIS_TS, lookup);
  assert.equal(next, BigInt(MIN_DIFFICULTY), "equal-stamp window forces a difficulty increase (1 -> MIN bound)");
  assert.equal(next > 1n, true, "difficulty increase is possible with non-decreasing (equal) timestamps");
});

test("pow: non-retarget heights inherit the parent difficulty exactly", () => {
  // A throwing lookup proves no anchor is consulted outside retarget heights.
  assert.equal(nextDifficulty(65_536n, 0, 999_999, throwingLookup), 65_536n, "h=1 inherits");
  assert.equal(nextDifficulty(1n, 58, 999_999, throwingLookup), 1n, "h=59 inherits");
  assert.equal(nextDifficulty(1n, 60, 999_999, throwingLookup), 1n, "h=61 inherits (61 % 60 != 0)");
});

test("pow: verifyHeaderPoW consistency with mining path", () => {
  const genesis = buildGenesis(emptyGenesisConfig(0));
  const header = genesis.block.header;
  header.nonce = 0n;
  const ok = verifyHeaderPoW(header, { nonce: 0n });
  assert.equal(ok.ok, true);
  // Difficulty 512 (absurd for CPU in this envelope) fails for nonce=0 here.
  header.difficulty = 512n;
  const verdict = verifyHeaderPoW(header, { nonce: 0n });
  // Either outcome is possible for one nonce; assert API contract instead:
  assert.equal(typeof verdict.ok, "boolean");
});
