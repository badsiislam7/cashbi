import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePeerAddress } from "../src/util/peer.js";
import { P2P_FRAME_LIMIT_BYTES } from "../src/config/params.js";

/**
 * Security guards:
 * - The repository MUST NOT hardcode individual peer IP addresses (project
 *   rule): peers come from DNS seeds, discovery feeds, cache, gossip, or
 *   operator configuration at runtime.
 * - The P2P frame limit keeps memory-bomb style attacks bounded.
 * - Peer address parsing is defensive.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", ".git"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else out.push(full);
  }
  return out;
}

test("security: no hardcoded non-loopback IPv4 addresses in src", () => {
  const violations: string[] = [];
  for (const file of collectSourceFiles("src")) {
    const content = stripComments(readFileSync(file, "utf8"));
    for (const line of content.split("\n")) {
      const matches = line.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
      for (const match of matches) {
        const addr = match[1];
        if (addr === "127.0.0.1" || addr === "0.0.0.0") continue;
        violations.push(`${file}: ${addr}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("security: peer address parser defensively rejects bad input", () => {
  assert.equal(parsePeerAddress("bad"), null);
  assert.equal(parsePeerAddress("host:0"), null);
  assert.equal(parsePeerAddress("host:99999"), null);
  assert.equal(parsePeerAddress("host:"), null);
  assert.equal(parsePeerAddress(""), null);
  assert.equal(parsePeerAddress("a".repeat(300) + ":80"), null);
  assert.equal(parsePeerAddress("a.b.c:8080"), "a.b.c:8080");
  assert.equal(parsePeerAddress("[::1]:9000"), "[::1]:9000");
  assert.equal(parsePeerAddress("10-1.2.3.4:80"), null);
});

test("security: p2p frame limit constant within sane bounds", () => {
  assert.equal(P2P_FRAME_LIMIT_BYTES >= 256 * 1024, true);
  assert.equal(P2P_FRAME_LIMIT_BYTES <= 64 << 20, true);
});
