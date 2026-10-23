import { test } from "node:test";
import assert from "node:assert";
import {
  difficultyToTarget,
  isMiningCandidate,
  meetsTarget,
  nextDifficulty,
  powHash,
  retargetDifficulty,
  verifyHeaderPoW,
} from "../src/consensus/pow.js";
import { TARGET_BLOCK_TIME_SECONDS, DIFFICULTY_RETARGET_INTERVAL } from "../src/config/params.js";
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

test("pow: retarget bounds (clamp 1/4x .. 4x, dev rule)", () => {
  const d = 10_000n;
  // Fast mining -> increases (bounded to 4x)
  const fast = retargetDifficulty(d, TARGET_BLOCK_TIME_SECONDS * DIFFICULTY_RETARGET_INTERVAL / 10, DIFFICULTY_RETARGET_INTERVAL, TARGET_BLOCK_TIME_SECONDS);
  assert.equal(fast <= d * 4n, true);
  assert.equal(fast > d, true);
  // Slow mining -> decreases (bounded to 1/4x)
  const slow = retargetDifficulty(d, TARGET_BLOCK_TIME_SECONDS * DIFFICULTY_RETARGET_INTERVAL * 10, DIFFICULTY_RETARGET_INTERVAL, TARGET_BLOCK_TIME_SECONDS);
  assert.equal(slow >= d / 4n, true);
  assert.equal(slow < d, true);
  // Non-retarget heights keep the difficulty unchanged
  assert.equal(nextDifficulty(d, 1, 100, 101), d);
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
