# Genesis PoW Mining Tool — Operational Guide

Status: **PREPARATION ONLY.** The tool described here is implemented and tested,
but **no real genesis nonce search has been run** and none is authorized by this
document. A real search is a separate, explicitly authorized operation.

## What the utility does

`scripts/mine-genesis.ts` (library: `src/tools/genesis-mining.ts`) runs
**bounded, checkpointed nonce searches** over the pinned CashBI genesis header
preimage. Each invocation:

1. Loads the pinned genesis header via the production chain code
   (`buildGenesis`) and computes the preimage digest with the production
   `hashHeaderWithoutNonce` (keccak256 over RLP of the header **without** the
   nonce — the nonce is excluded from the preimage, so the tool can safely set
   candidate nonces on the plan header without mutating the genesis
   configuration).
2. Partitions the uint64 nonce space into one lane per worker: worker `w` owns
   chunks `[start + (k·workers + w)·laneChunkSize, … + laneChunkSize)`. Lanes
   are mathematically disjoint; all workers' k-th chunks together cover each
   wave contiguously.
3. Hashes nonces within a per-invocation attempt budget, checking each nonce
   against the **production** target test (`isMiningCandidate`), i.e. the same
   consensus code the node uses for block sync. No duplicated or weakened PoW.
4. Writes validated, versioned checkpoints atomically (temp file + rename) at
   batch boundaries so an invocation can be stopped and resumed exactly.

## What it does NOT do

- It does **not** mine on import, on `npm test`, or as a side effect of any
  package script. A nonce search happens **only** when every required argument
  is present **and** the explicit `--mine` flag is given.
- It does **not** modify `src/chain/genesis.ts`, the pinned genesis nonce
  (currently `0`), `POW_LIMIT`, difficulty rules, chain ID, supply, rewards,
  `DEV_PARAM_VERSION`, or the handshake.
- It does **not** treat a target-passing nonce as valid on its own: every
  candidate is re-verified through the production `verifyHeaderPoW`, and the
  genesis hash is re-derived with the production `blockHash`, before being
  written to a result artifact.
- It is not an unbounded "run forever" miner. There is no command that silently
  starts unlimited mining.

## Running tests without mining

```bash
npm test                # full deterministic suite; no mining subprocess hashing
npx tsc --noEmit        # typecheck
npm run lint
npm run security:check
```

The mining-tool tests (`test/genesis-mining-tool.test.ts`) are bounded: at most
a few dozen nonces per test, tiny synthetic ranges, and subprocess CLI tests
with explicit small attempt limits.

## Bounded smoke test

```bash
mkdir -p /tmp/genesis-smoke
npm run mine-genesis -- \
  --start 0x0 \
  --max-attempts 40 \
  --workers 2 \
  --checkpoint /tmp/genesis-smoke/cp.json \
  --mine --chunk-size 5 --checkpoint-every 10
```

This hashes **at most** 40 nonces (2 workers × ≤20), prints measured rate and
attempt counts, writes `/tmp/genesis-smoke/cp.json`, and stops. Without
`--mine` (or with any required argument missing) the script prints usage / a
plan preview and performs **no** hashing.

Plan preview (no files written, no hashing):

```bash
npm run mine-genesis -- --start 0x0 --max-attempts 1000 --workers 2 \
  --checkpoint /tmp/genesis-smoke/cp.json --dry-run
```

## Safety gate (argument contract)

Required for a mining run: `--start <0x-hex|decimal>`, `--max-attempts <n>`,
`--workers <n>`, `--checkpoint <path>`, **and** `--mine`. Optional:
`--result <path>` (default `<checkpoint>.result.json`), `--chunk-size`,
`--checkpoint-every`. Missing anything → usage output, exit code 2, no search.

Exit codes: `0` success · `2` usage/argument error · `3` invalid checkpoint or
plan mismatch (aborts without touching the file) · `1` runtime error · `130`
interrupted by SIGINT.

## Checkpointing and resuming

The checkpoint (`cashbi-genesis-mining-checkpoint`, version 1) stores:

- schema/version, creation and last-update timestamps;
- the exact genesis preimage digest, chain ID, difficulty, `POW_LIMIT`,
  target block time, retarget interval and `DEV_PARAM_VERSION`;
- the plan (start nonce, worker count, frozen `laneChunkSize`);
- per worker: `nextNonce` (exact resume position inside its own lane), own
  chunk index, per-worker attempts, and an `exhausted` flag for workers whose
  lane reached the maximum-uint64 clamped chunk;
- total attempts, checkpoint count, and a `candidate` record when found.

## Attempt budget semantics

`--max-attempts <n>` sets a **per-invocation** attempt budget, not a cumulative
limit across checkpoint history. Each invocation gets its own fresh budget of
`n` attempts, distributed across workers (the first `n % workers` workers get
`floor(n/workers) + 1`, the rest get `floor(n/workers)`). A resume invocation
with the same `--max-attempts` will perform up to `n` additional attempts,
regardless of how many attempts were recorded in previous invocations.

The checkpoint's `totalAttempts` field records the cumulative sum across all
invocations and is used only for record-keeping and re-verification — it is
never compared against `--max-attempts`.

Validation on every load rejects: wrong schema/version, preimage drift
(stale checkpoint from a different genesis configuration), consensus-constant
mismatches, workers/counters outside their lane (overlap or gap), attempt
count-sum mismatches, and malformed candidate records. A malformed JSON file is
**never silently reset** — the tool aborts and an operator must consciously
move or delete the file.

Resume requires the **same** `--start` and `--workers` (mismatches abort with
exit 3); `--max-attempts` is a fresh per-invocation budget. Each worker
continues at its exact saved nonce: no completed attempt is reprocessed, and no
other worker's lane is touched.

## Stopping and resuming in Codespaces

- **Ctrl+C (SIGINT):** the runner finishes the current batch, persists the
  checkpoint, and exits. Resume later with identical arguments.
- **Codespace stopped/rebuilt:** `/tmp` is wiped with the container — keep
  checkpoints in a persistent location (repository worktree paths are
  persistent across Codespace restarts of the same codespace). If you used a
  `/tmp` path and lost it, simply start a fresh checkpoint; nothing else is
  affected because the chain itself was never touched.
- Resume is a fresh process invocation. There is no background daemon: a
  process that is killed between checkpoint writes loses at most the currently
  executing batch (a few hundred nonces of re-hashing; attempt counters may
  slightly over-count such re-hashes but coverage never gaps and lanes never
  overlap).

## Expected computational cost (ESTIMATE)

- `POW_LIMIT = 0x00000000ffff0000…0000` (Bitcoin mainnet compact `0x1d00ffff`),
  so the expected number of hashes per valid nonce is
  `2^256 / (POW_LIMIT + 1) = 4,295,032,833` (~2³²).
- The measured `powHash` throughput of the single-threaded in-process search is
  ~24,400 hashes/s ⇒ a mean search time of ≈ **48.9 hours single-threaded**
  (roughly halved with 2 workers on separate cores, tuned `--chunk-size`).
  **This is an ESTIMATE**, not a guarantee: throughput depends on the machine,
  and the geometric distribution has high variance.

A real search should only be started with an explicit decision, using bounded
invocations chained through the checkpoint (e.g. `--max-attempts 5000000`
repeatedly).

## Verifying a discovered candidate before activation

The tool writes a result artifact (`<checkpoint>.result.json` by default,
atomic, refuses to overwrite different existing content) containing: nonce
(0x + decimal), header fields, preimage digest, `powHash`, target, difficulty,
`powLimit`, genesis hash, chain ID, and `paramVersion`. A candidate is
UNTRUSTED until:

1. The checkpoint-embedded record is re-derived through the production
   validator (`verifyHeaderPoW`) and matches byte-for-byte — the tool enforces
   this on any resume and hard-fails otherwise.
2. An independent reproduction passes: recompute `keccak256(rlp(headerPreimage
   with nonce))` → double-SHA-256 → compare against target with a
   **non-TypeScript implementation** (as done previously with hand-rolled RLP +
   PyCryptodome for the genesis preimage audit), and re-derive
   `blockHash(header with nonce)`.
3. The genesis hash is checked against the expected chain parameters
   (chainId 901291, `paramVersion 0.0.1-dev` state).

Activation is a **separate future task**: pinning the nonce in
`src/chain/genesis.ts`, enabling startup genesis PoW validation, and any
parameter-version change. None of that is automated by this tool.

## Why no pinning/validation until a verified candidate exists

The current pinned nonce `0` **fails** the production `verifyHeaderPoW`
(verified earlier; the genesis import path bypasses it by design). If startup
genesis validation were enabled before a valid nonce exists, every fresh node
would reject its own hardcoded genesis and refuse to start. Therefore: keep
`DEV_PARAM_VERSION "0.0.1-dev"`, keep nonce `0` pinned, keep genesis import
bypassed — until a verified candidate is produced by a real, authorized search.

## New chain implication: archive old data directories

The re-mined genesis header changes the genesis hash, i.e. the chain root.
Existing `data/` directories (blockstore, state, peer logs) belong to the old
chain and **must not be mixed** with the new one. Before first startup with a
new genesis: stop nodes, move (`mv`) the old directories aside (e.g. to
`archive/<date>-pre-remine/`), then let nodes create fresh directories. Never
point a node at a mix of old and new genesis data.
