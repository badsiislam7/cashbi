import { test } from "node:test";
import assert from "node:assert";
import {
  difficultyToTarget,
  lowerMedian,
  meetsTarget,
  nextDifficulty,
  powHash,
  retargetDifficulty,
  verifyHeaderPoW,
  virtualAnchorTimestamp,
} from "../src/consensus/pow.js";
import { MAX_DIFFICULTY, MIN_DIFFICULTY, POW_LIMIT, TARGET_BLOCK_TIME_SECONDS, DIFFICULTY_RETARGET_INTERVAL } from "../src/config/params.js";
import { emptyGenesisConfig, buildGenesis } from "../src/chain/genesis.js";
import { randomBytes32, sha256 } from "../src/crypto/hash.js";
import { toHex, utf8ToBytes, concatBytes } from "../src/util/bytes.js";
import { hashHeaderWithoutNonce } from "../src/chain/block.js";
import { bigToHexBE } from "../src/util/bytes.js";
import { Blockchain } from "../src/chain/blockchain.js";
import { buildBlockForMining } from "../src/mining/candidate.js";
import { Mempool } from "../src/tx/mempool.js";

const EXPECTED_ELAPSED = DIFFICULTY_RETARGET_INTERVAL * TARGET_BLOCK_TIME_SECONDS; // 1536 × 600 = 921,600
const CLAMP_LOW = EXPECTED_ELAPSED / 4; // 230,400 (rise capped at exactly 4x)
const CLAMP_HIGH = EXPECTED_ELAPSED * 4; // 3,686,400 (fall capped at exactly 1/4)

test("pow: difficulty 1 maps to POW_LIMIT, higher difficulty shrinks the window", () => {
  // Difficulty 1 maps to POW_LIMIT, not 2^256, so not every digest passes.
  assert.equal(difficultyToTarget(1n), POW_LIMIT);
  assert.equal(difficultyToTarget(2n), POW_LIMIT / 2n);
});

test("pow: PoW digest is double-SHA-256 over rlp(headerWithoutNonce) || 8-byte BE nonce (pinned vectors)", () => {
  // Primitive pins (independent implementation path: noble sha256 directly).
  const v1 = utf8ToBytes("cashbi-pow-vector-one");
  assert.equal(
    toHex(sha256(sha256(v1))),
    "0x992a76c95f38ce18bfeb295483840a2f9a7518940cbb523726a4119f05b391ec",
  );
  const v2 = utf8ToBytes("cashbi-pow-vector-two");
  assert.equal(
    toHex(sha256(sha256(v2))),
    "0x9c0cd0fcbff420c128ca7600aa1c59c5f58a12b67b0b1a304d3ce54d82d3825a",
  );
  // Mining-path consistency: miner and validator share this exact construction.
  const genesis = buildGenesis(emptyGenesisConfig(0));
  const header = genesis.block.header;
  header.nonce = 0x0102030405060708n;
  const expected = sha256(sha256(concatBytes(hashHeaderWithoutNonce(header), bigToHexBE(header.nonce & 0xffffffffffffffffn, 8))));
  assert.equal(toHex(powHash(header, header.nonce)), toHex(expected));
  // Changing the nonce changes the digest (nonce truly participates).
  assert.notEqual(toHex(powHash(header, 1n)), toHex(powHash(header, 2n)));
});

test("pow: difficulty 1 target boundary — digest at target passes, one above fails", () => {
  // POW_LIMIT as a 32-byte big-endian digest: 0x00000000ffff0000...0000
  const atTarget = new Uint8Array(32);
  atTarget[4] = 0xff;
  atTarget[5] = 0xff;
  assert.equal(meetsTarget(atTarget, 1n), true, "digest exactly at POW_LIMIT passes");

  // One above POW_LIMIT: ...ffff0001
  const aboveTarget = new Uint8Array(32);
  aboveTarget[4] = 0xff;
  aboveTarget[5] = 0xff;
  aboveTarget[31] = 0x01;
  assert.equal(meetsTarget(aboveTarget, 1n), false, "digest one above POW_LIMIT fails");
});

test("pow: difficulty 1 rejects most hashes", () => {
  const genesis = buildGenesis(emptyGenesisConfig(0));
  const header = genesis.block.header;
  header.extraData = randomBytes32();
  let found = false;
  for (let nonce = 0n; nonce < 1000n; nonce++) {
    if (meetsTarget(powHash(header, nonce), 1n)) found = true;
  }
  // With target = POW_LIMIT (~2^224), 1000 random nonces should almost never
  // find a valid proof of work.
  assert.equal(found, false, "difficulty 1 should reject most hashes");
});

test("pow: zero and negative difficulty are rejected", () => {
  assert.throws(() => difficultyToTarget(0n), /difficulty must be >= 1/);
  assert.throws(() => difficultyToTarget(-1n), /difficulty must be >= 1/);
});

test("pow: difficultyToTarget inverse behavior", () => {
  const t1 = difficultyToTarget(2n);
  const t2 = difficultyToTarget(4n);
  assert.equal(t2 < t1, true); // higher difficulty = lower target
});

test("pow: retarget bounds (clamped to exactly 4x / 1/4x by the elapsed clamps [230400, 3686400])", () => {
  const d = 10_000n;
  // Fast mining -> increases (bounded to exactly 4x at the lower clamp)
  const fast = retargetDifficulty(d, 100_000); // below lower clamp -> 230,400
  assert.equal(fast, d * 4n, "elapsed below expected/4 clamps to 230400 first, giving exactly 4x");
  // Slow mining -> decreases (bounded to exactly one quarter at the upper clamp)
  const slow = retargetDifficulty(d, 40_000_000); // above upper clamp -> 3,686,400
  assert.equal(slow, d / 4n, "elapsed above 4*expected clamps to 3686400 first, giving exactly 1/4");
  // Non-retarget heights keep the difficulty unchanged (anchors never consulted)
  assert.equal(nextDifficulty(d, 1, 101, throwingLookup), d);
});

test("pow: difficulty cannot drop below MIN_DIFFICULTY", () => {
  const d = BigInt(MIN_DIFFICULTY); // already at the floor
  const slow = retargetDifficulty(d, 60_000_000);
  assert.equal(slow, d, "difficulty cannot drop below MIN_DIFFICULTY");
});

test("pow: difficulty cannot exceed MAX_DIFFICULTY", () => {
  const d = BigInt(MAX_DIFFICULTY); // already at maximum
  const fast = retargetDifficulty(d, 1);
  assert.equal(fast, d, "difficulty cannot exceed MAX_DIFFICULTY");
});

test("pow: difficulty cannot drop below MIN_DIFFICULTY even with extreme retarget", () => {
  const d = 1_000_000n; // start well above minimum
  let current = d;
  // Simulate many retargets with maximally slow blocks (elapsed clamps high each time)
  for (let i = 0; i < 100; i++) {
    current = retargetDifficulty(current, 9_999_999);
  }
  assert.equal(current, BigInt(MIN_DIFFICULTY), "difficulty should floor at MIN_DIFFICULTY after many slow retargets");
});

test("pow: difficulty cannot exceed MAX_DIFFICULTY even with extreme retarget", () => {
  const d = BigInt(MAX_DIFFICULTY) / 1000n; // start well below maximum
  let current = d;
  // Simulate many retargets with maximally fast blocks (elapsed clamps low each time)
  for (let i = 0; i < 100; i++) {
    current = retargetDifficulty(current, 1);
  }
  assert.equal(current, BigInt(MAX_DIFFICULTY), "difficulty should cap at MAX_DIFFICULTY after many fast retargets");
});

function throwingLookup(height: number): number {
  throw new Error(`anchor lookup must not be consulted (got height ${height})`);
}

const GENESIS_TS = 1_700_000_000;

/** Honest steady-state chain stamps: ts(h) = GENESIS_TS + h*600 (10 min/block). */
function honestLookupSpy(): { lookup: (height: number) => number; queried: Array<{ height: number; ts: number }> } {
  const queried: Array<{ height: number; ts: number }> = [];
  return {
    queried,
    lookup: (height: number) => {
      const ts = height >= 0 ? GENESIS_TS + height * TARGET_BLOCK_TIME_SECONDS : virtualAnchorTimestamp(height, GENESIS_TS);
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
  assert.equal(retargetDifficulty(D, EXPECTED_ELAPSED), D, "elapsed == expected (921600) -> unchanged");
  assert.equal(retargetDifficulty(D, CLAMP_LOW), 262_144n, "elapsed = expected/4 (230400) -> exactly x4");
  assert.equal(retargetDifficulty(D, CLAMP_HIGH), 16_384n, "elapsed = 4x expected (3686400) -> exactly /4");
  assert.equal(retargetDifficulty(D, CLAMP_LOW - 1), retargetDifficulty(D, CLAMP_LOW), "below lower clamp: clamped before division");
  assert.equal(retargetDifficulty(D, CLAMP_HIGH + 1), retargetDifficulty(D, CLAMP_HIGH), "above upper clamp: clamped before division");
  // Non-divisible dividends use exact BigInt floor division (no floats, no rounding).
  assert.equal(retargetDifficulty(1_048_577n, 350_000), 2_761_053n, "1048577*921600/350000 floor = 2761053");
  assert.equal(retargetDifficulty(7n, 300_000), 21n, "7*921600/300000 = 21 (tiny difficulty above floor stays)");
  // Minimum/maximum bounds.
  assert.equal(retargetDifficulty(BigInt(MIN_DIFFICULTY), CLAMP_HIGH), 1n, "921600/3686400 floors to 0 -> clamped to MIN=1");
  assert.equal(retargetDifficulty(BigInt(MIN_DIFFICULTY), 999_999_999), 1n, "extreme slow window floors at MIN");
  assert.equal(retargetDifficulty(BigInt(MAX_DIFFICULTY), CLAMP_LOW), BigInt(MAX_DIFFICULTY), "MAX-bound fast window stays at MAX");
  // Determinism guard: fractional elapsed values are rejected outright.
  assert.throws(() => retargetDifficulty(D, 60.5), /integer/);
});

test("pow: retarget boundary heights — samples and lower medians at h = 1536, 3072, 4608 (hand table)", () => {
  // Honest 10 min/block stamps; hand table for the interval-1536 convention:
  //   h=1536: old heights [-9..0]   (virtual) LM = G-3000; new [1527..1536] LM = ts(1531) = G+918600 → elapsed 921600
  //   h=3072: old heights [1527..1536] LM = G+918600; new [3063..3072] LM = ts(3067) = G+1840200 → elapsed 921600
  //   h=4608: old heights [3063..3072] LM = G+1840200; new [4599..4608] LM = ts(4603) = G+2761800 → elapsed 921600
  for (const [parentHeight, expectedFirstQueriedHeight, expectedFirstQueriedTs, expectedNewFirstHeight, expectedNewFirstTs] of [
    [1535, -9, GENESIS_TS - 9 * TARGET_BLOCK_TIME_SECONDS, 1527, GENESIS_TS + 1527 * TARGET_BLOCK_TIME_SECONDS],
    [3071, 1527, GENESIS_TS + 1527 * TARGET_BLOCK_TIME_SECONDS, 3063, GENESIS_TS + 3063 * TARGET_BLOCK_TIME_SECONDS],
    [4607, 3063, GENESIS_TS + 3063 * TARGET_BLOCK_TIME_SECONDS, 4599, GENESIS_TS + 4599 * TARGET_BLOCK_TIME_SECONDS],
  ] as Array<[number, number, number, number, number]>) {
    const probe = honestLookupSpy();
    const h = parentHeight + 1;
    const next = nextDifficulty(65_536n, parentHeight, GENESIS_TS + h * TARGET_BLOCK_TIME_SECONDS, probe.lookup);
    assert.equal(next, 65_536n, `h=${h}: steady honest chain keeps difficulty unchanged`);
    // Membership: old sample heights h-1545..h-1536 and new sample heights
    // h-9..h-1 were consulted (h comes from nextTimestamp directly) = 19 lookups.
    const queried = probe.queried;
    assert.equal(queried.length, 19, "exactly 19 anchor lookups (10 old + 9 new)");
    assert.equal(queried[0].height, expectedFirstQueriedHeight, "first consulted anchor is the oldest old-sample height");
    assert.equal(queried[0].ts, expectedFirstQueriedTs, "oldest old-sample timestamp matches the hand table");
    assert.equal(queried[9].height, h - DIFFICULTY_RETARGET_INTERVAL, "10th consulted anchor is the newest old-sample height");
    assert.equal(queried[10].height, expectedNewFirstHeight, "11th consulted anchor is the oldest new-sample height");
    assert.equal(queried[10].ts, expectedNewFirstTs, "oldest new-sample timestamp matches the hand table");
    assert.equal(queried[18].height, h - 1, "19th consulted anchor is the parent height");
  }
});

test("pow: first retarget at h = 1536 uses virtual anchors scaled by the target interval", () => {
  // Heights -9..0 at h=1536 are virtual anchors VTS(x) = G + x*600. A steady
  // honest chain measures elapsed exactly 921,600 at the FIRST retarget —
  // the same as every later retarget measures from real branch history.
  const probe = honestLookupSpy();
  const next = nextDifficulty(65_536n, 1535, GENESIS_TS + 1536 * TARGET_BLOCK_TIME_SECONDS, probe.lookup);
  assert.equal(next, 65_536n, "first retarget on a steady chain leaves difficulty unchanged (elapsed exactly 921600)");
  assert.equal(probe.queried.some((q) => q.height === -1), true, "virtual anchor height -1 was consulted");
  assert.equal(probe.queried.some((q) => q.height === -9), true, "virtual anchor height -9 was consulted");
  assert.equal(probe.queried.some((q) => q.height === 0), true, "real genesis height 0 is part of the old sample window");
  assert.equal(virtualAnchorTimestamp(-1, GENESIS_TS), GENESIS_TS - TARGET_BLOCK_TIME_SECONDS, "VTS(-1) = genesis_ts - 600");
  assert.equal(virtualAnchorTimestamp(-1536, GENESIS_TS), GENESIS_TS - EXPECTED_ELAPSED, "VTS(-1536) = genesis_ts - 921600");
  // The clamp-to-genesis alternative (VTS(x) = G for x < 0) would measure
  // elapsed 918,600 here and produce a biased retarget — pinned away:
  // 65536 * 921600 / 918600 = 65,750.41... (floor 65750) instead of unchanged.
  const clampVariant = nextDifficulty(65_536n, 1535, GENESIS_TS + 1536 * TARGET_BLOCK_TIME_SECONDS, (height) =>
    height < 0 ? GENESIS_TS : GENESIS_TS + height * TARGET_BLOCK_TIME_SECONDS);
  assert.equal(clampVariant, (65536n * BigInt(EXPECTED_ELAPSED)) / 918_600n, "the rejected clamp-variant would give a different (biased) result");
  assert.notEqual(clampVariant, 65_536n);
});

test("pow: equal-stamp window RAISES difficulty by the exact 4x bound (one-sidedness regression)", () => {
  // Blocks 1..1535 all stamped at the genesis second: LM(new) = G, LM(old) =
  // G - 3000 (virtual anchors), elapsed 3000 -> clamped to 230400 -> 4x.
  const lookup = (height: number) => height >= 0 ? GENESIS_TS : virtualAnchorTimestamp(height, GENESIS_TS);
  const next = nextDifficulty(1n, 1535, GENESIS_TS, lookup);
  assert.equal(next, 4n, "equal-stamp window forces the maximum 4x increase (1 -> 4)");
  assert.equal(next > 1n, true, "difficulty increase is possible with non-decreasing (equal) timestamps");
});

test("pow: side branches retarget from their own stamps, not canonical history (callback contract)", () => {
  // A slightly slower side branch: stamps 700 s/block. Old sample [1527..1536]
  // at h=3072 vs new [3063..3072]: elapsed = 600*1536 + 100*10 = 922,600 —
  // within the un-clamped range, so the difficulty falls slightly, expressed
  // as an exact floor division. This pinpoints that timestamps come only from
  // the branch supplied via the callback.
  const sideTs = (height: number) => height >= 0 ? GENESIS_TS + height * (TARGET_BLOCK_TIME_SECONDS + 100) : virtualAnchorTimestamp(height, GENESIS_TS);
  const h = 3072;
  const next = nextDifficulty(65_536n, h - 1, GENESIS_TS + h * 700, sideTs);
  // old LM = G + 1531*700; new LM = G + 3067*700; elapsed = 1536*700 = 1,075,200.
  assert.equal(next, (65536n * BigInt(EXPECTED_ELAPSED)) / 1_075_200n, "slow side branch reduces difficulty by exact floor division");
  // Missing anchor history is a hard, deterministic error (pruning edge):
  assert.throws(() => nextDifficulty(65_536n, 3071, 999, () => {
    throw new Error("no block on this branch at anchor height 1527");
  }), /anchor height 1527/);
});

test("pow: non-retarget heights inherit the parent difficulty exactly", () => {
  // A throwing lookup proves no anchor is consulted outside retarget heights.
  assert.equal(nextDifficulty(65_536n, 0, 999_999, throwingLookup), 65_536n, "h=1 inherits");
  assert.equal(nextDifficulty(1n, 60, 999_999, throwingLookup), 1n, "h=61 inherits (60 % 1536 != 0)");
  assert.equal(nextDifficulty(1n, 1536, 999_999, throwingLookup), 1n, "h=1537 inherits");
});

test("pow: verifyHeaderPoW consistency with mining path", () => {
  const genesis = buildGenesis(emptyGenesisConfig(0));
  const header = genesis.block.header;
  header.nonce = 0n;
  const ok = verifyHeaderPoW(header, { nonce: 0n });
  // At difficulty 1 with target = POW_LIMIT, genesis nonce 0 almost certainly
  // does not pass PoW (~2^32 hashes expected). The API contract is that ok
  // is always a boolean; miner and validator share the same target.
  assert.equal(typeof ok.ok, "boolean");
  assert.equal(ok.ok, false, "genesis nonce 0 fails PoW at difficulty 1 under POW_LIMIT");
  // High difficulty always fails.
  header.difficulty = 512n;
  const verdict = verifyHeaderPoW(header, { nonce: 0n });
  assert.equal(typeof verdict.ok, "boolean");
  assert.equal(verdict.ok, false);
});

test("pow: difficultyToTarget rejects invalid difficulty inputs", () => {
  // difficultyToTarget throws on values < 1. This is the helper-level
  // behavior that tryImport must guard against: the block-import path
  // must reject invalid difficulty instead of propagating the throw.
  assert.throws(() => difficultyToTarget(0n), /difficulty must be >= 1/);
  assert.throws(() => difficultyToTarget(-1n), /difficulty must be >= 1/);
  assert.doesNotThrow(() => difficultyToTarget(1n));
  assert.doesNotThrow(() => difficultyToTarget(BigInt(MIN_DIFFICULTY)));
});

test("pow: acceptBlock rejects block with invalid PoW (nonce 0 at difficulty 1)", () => {
  const genesisCfg = emptyGenesisConfig(0);
  genesisCfg.allocations = [{ address: "0x" + "00".repeat(20), balance: 1000n * 10n ** 18n }];
  const genesis = buildGenesis(genesisCfg);
  const chain = new Blockchain(genesisCfg);
  const mempool = new Mempool();
  const template = buildBlockForMining({
    chain,
    mempool,
    coinbase: "0x" + "00".repeat(20),
    timestamp: Number(genesis.block.header.timestamp) + 600,
    activeReward: 2n * 10n ** 18n,
    extraData: new TextEncoder().encode("test"),
  });
  assert.notEqual(template, null, "block template must be buildable");
  // Nonce 0 does not satisfy POW_LIMIT at difficulty 1 (~2^32 hashes
  // expected). acceptBlock must reject it through the production PoW path.
  const receipt = chain.acceptBlock(template!);
  assert.equal(receipt.accepted, false, "block with invalid PoW must be rejected");
  assert.match(receipt.reason ?? "", /PoW/);
});

// NOTE: A test proving a VALID PoW header is accepted by acceptBlock requires
// a precomputed nonce satisfying powHash(header, nonce) <= POW_LIMIT at
// difficulty 1. Expected work: ~2^32 hashes (~5-6 days at ~13K H/s on this
// hardware). Background miners are running to generate one; when found, the
// nonce and header will be added here as a deterministic test vector.
//
// See /tmp/opencode/found_nonce.json and the parallel miners at
// /tmp/opencode/parallel_mine.mjs (workers 0-3).
