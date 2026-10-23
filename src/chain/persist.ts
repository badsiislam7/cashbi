/**
 * Append-only ledger persistence (JSONL) for chain data, plus checksums.
 * Intended for dev data directories; production storage engines are an open
 * milestone (see UNRESOLVED_DECISIONS.md D-18).
 */
import { createHash } from "node:crypto";
import { mkdirSync, openSync, writeSync, closeSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256HexFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Appends one canonical record (Uint8Array) as one base64 JSONL line.
 * Synchronous by design: block appends must keep ledger order (crash
 * consistency for the append-only log) and complete before callers read.
 */
export function appendLedger(filePath: string, record: Uint8Array): void {
  if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const handle = openSync(filePath, "a");
  try {
    writeSync(handle, JSON.stringify({ b64: Buffer.from(record).toString("base64") }) + "\n");
  } finally {
    closeSync(handle);
  }
}

/** Reads all base64 records from a JSONL ledger, skipping corrupt lines. */
export function readLedger(filePath: string): Uint8Array[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split("\n");
  const out: Uint8Array[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: { b64?: string } = JSON.parse(trimmed);
      if (typeof parsed.b64 !== "string") throw new Error("missing b64");
      out.push(new Uint8Array(Buffer.from(parsed.b64, "base64")));
    } catch {
      // Corrupt trailing line: stop scanning (append-only log semantics).
      break;
    }
  }
  return out;
}

/** Deletes and rewrites the ledger file with the supplied records, in order. */
export function writeLedger(filePath: string, records: Uint8Array[]): void {
  // Truncate then append the supplied records in order (sync to preserve order).
  if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const handle = openSync(filePath, "w");
  try {
    for (const record of records) {
      writeSync(handle, JSON.stringify({ b64: Buffer.from(record).toString("base64") }) + "\n");
    }
  } finally {
    closeSync(handle);
  }
}
