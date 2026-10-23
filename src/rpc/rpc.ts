/**
 * HTTP JSON-RPC interface for the dev node (Ethereum-style endpoints where
 * applicable plus CashBI specifics).
 *
 * Security: binds to the loopback interface by default; operators who expose
 * it externally assume full risk (see docs/security.md).
 */
import { createServer, type Server } from "node:http";
import type { FullNode } from "../node/node.js";
import type { Block } from "../chain/block.js";
import { blockHash } from "../chain/block.js";
import { decodeSignedTransaction, txHash, type Transaction } from "../tx/transaction.js";
import { fromHex, toHex } from "../util/bytes.js";

export interface RpcRequestPayload {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown[];
}

function success(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function failure(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export class RpcServer {
  private server: Server | null = null;

  constructor(private readonly node: FullNode) {}

  async start(port: number, host = "127.0.0.1"): Promise<void> {
    this.server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(failure(null, -32000, "POST only"));
        return;
      }
      let body = Buffer.alloc(0);
      req.on("data", (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
        if (body.length > 4 << 20) {
          res.writeHead(413);
          res.end(failure(null, -32001, "payload too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body.toString("utf8") || "{}") as RpcRequestPayload;
          const response = this.handle(payload);
          res.writeHead(200);
          res.end(response);
        } catch {
          res.writeHead(400);
          res.end(failure(null, -32700, "parse error"));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.removeAllListeners("error");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Handles a single JSON-RPC payload. Never throws. */
  handle(payload: RpcRequestPayload): string {
    if (payload.jsonrpc !== "2.0") return failure(payload.id, -32600, "jsonrpc must be 2.0");
    switch (payload.method) {
      case "eth_chainId":
        return success(payload.id, "0x" + this.node.chain.chainId.toString(16));
      case "net_peerCount":
        return success(payload.id, this.node.peerCount());
      case "net_listening":
        return success(payload.id, true);
      case "bic_getBestBlockHash":
        return success(payload.id, this.node.chain.tip.hash);
      case "bic_getBestBlockNumber":
        return success(payload.id, this.node.chain.tip.number);
      case "bic_getBalance": {
        const [address] = (payload.params ?? []) as string[];
        const account = this.node.chain.tipState.getAccount(address ?? "");
        if (!account) return success(payload.id, "0x0");
        return success(payload.id, toHex(bigToBePad(account.balance)));
      }
      case "bic_getBlockByNumber": {
        const [number] = (payload.params ?? []) as number[];
        if (!Number.isInteger(number) || number < 0) {
          return failure(payload.id, -32002, "bic_getBlockByNumber requires an integer height");
        }
        const block = this.node.chain.getBlockByNumber(number);
        if (!block) return success(payload.id, null);
        return success(payload.id, blockSummary(block, this.node.chain));
      }
      case "bic_getBlockByHash": {
        const [hash] = (payload.params ?? []) as string[];
        const found = hash ? this.node.chain.getBlock(hash) : null;
        if (!found) return success(payload.id, null);
        return success(payload.id, blockSummary(found.block, this.node.chain));
      }
      case "bic_mempoolSize":
        return success(payload.id, this.node.mempool.stats().size);
      case "bic_sendRawTransaction": {
        const [raw] = (payload.params ?? []) as string[];
        let tx: Transaction;
        try {
          tx = decodeSignedTransaction(fromHex(raw ?? ""));
        } catch (err) {
          return failure(payload.id, -32003, `invalid transaction: ${(err as Error).message}`);
        }
        // Sender balance/nonce are checked against the tip at mempool entry.
        const result = this.node.submitTransaction(tx);
        if (!result.accepted) return failure(payload.id, -32004, result.reason ?? "rejected");
        return success(payload.id, result.hash);
      }
      case "bic_mineStatus": {
        const status = this.node.minerStatus();
        return success(payload.id, {
          minerAttached: status !== null,
          mining: status?.mining ?? false,
          consent: status?.consent ?? false,
          rounds: status?.rounds ?? 0,
          hashesTried: status?.hashesTried ?? 0,
        });
      }
      default:
        return failure(payload.id, -32601, `method "${payload.method}" not found`);
    }
  }
}

function bigToBePad(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return fromHex(hex);
}

function blockSummary(block: Block, _chain: import("../chain/blockchain.js").Blockchain): Record<string, unknown> {
  return {
    hash: blockHash(block.header),
    number: block.header.number,
    parentHash: block.header.parentHash,
    timestamp: block.header.timestamp,
    difficulty: "0x" + block.header.difficulty.toString(16),
    coinbase: block.header.coinbase,
    transactionsRoot: block.header.transactionsRoot,
    stateRoot: block.header.stateRoot,
    gasUsed: toHex(bigToBePad(block.header.gasUsed)),
    gasLimit: toHex(bigToBePad(block.header.gasLimit)),
    txCount: block.transactions.length,
    transactions: block.transactions.map((tx) => txHash(tx)),
  };
}
