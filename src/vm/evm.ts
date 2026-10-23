/**
 * Minimal EVM-compatible interpreter (subscript "miniEVM").
 *
 * Supports the core EVM opcode set needed for typical simple contracts:
 * arithmetic, comparison, bitwise, memory, storage (SLOAD/SSTORE), context
 * (CALLER/CALLVALUE/ADDRESS/CALLDATASIZE/TIMESTAMP/NUMBER), control flow
 * (JUMP/JUMPI/JUMPDEST), and RETURN/REVERT.
 *
 * Gas accounting uses a simple dev-default schedule (params.ts, decision D-9).
 *
 * NOT a full Ethereum Yellow Paper implementation: missing precompiles,
 * CALL/CREATE delegation depth, logs, and bytecode that relies on them will
 * abort with an unsupported-opcode revert. This is a documented, deliberate
 * scope cut for the dev milestone (see UNRESOLVED_DECISIONS.md, D-15).
 */
import {
  BASE_OPCODE_GAS,
  CREATE_TX_GAS,
  EXPENSIVE_OPCODE_GAS,
  MAX_BLOCK_GAS,
  MEMORY_OPCODE_GAS,
  STORAGE_GAS,
} from "../config/params.js";
import { keccak256Hex } from "../crypto/hash.js";
import { RLP } from "../rlp/rlp.js";
import { fromHex, hexBEToBig, padLeft } from "../util/bytes.js";
import { Journal } from "../state/world.js";
import { addressToWord } from "../tx/transaction.js";

/** Bytecode opcodes (EVM numeric order, subset implemented). */
export enum OpCode {
  STOP = 0x00,
  ADD = 0x01,
  SUB = 0x02,
  MUL = 0x03,
  DIV = 0x04,
  SDIV = 0x05,
  MOD = 0x06,
  ADDMOD = 0x08,
  MULMOD = 0x09,
  NOT = 0x19,
  LT = 0x10,
  GT = 0x11,
  SLT = 0x12,
  SGT = 0x13,
  EQ = 0x14,
  ISZERO = 0x15,
  AND = 0x16,
  OR = 0x17,
  XOR = 0x18,
  POP = 0x50,
  MLOAD = 0x51,
  MSTORE = 0x52,
  MSTORE8 = 0x53,
  SLOAD = 0x54,
  SSTORE = 0x55,
  JUMP = 0x56,
  JUMPI = 0x57,
  PC = 0x58,
  ADDRESS = 0x30,
  BALANCE = 0x31,
  CALLER = 0x33,
  CALLVALUE = 0x34,
  CALLDATASIZE = 0x36,
  CALLDATALOAD = 0x37,
  TIMESTAMP = 0x42,
  NUMBER = 0x43,
  SELFBALANCE = 0x47,
  GASPRICE = 0x3a,
  GAS = 0x5a,
  JUMPDEST = 0x5b,
  PUSH1 = 0x60,
  PUSH32 = 0x7f,
  DUP1 = 0x80,
  DUP2 = 0x81,
  DUP3 = 0x82,
  DUP4 = 0x83,
  DUP5 = 0x84,
  SWAP1 = 0x90,
  SWAP2 = 0x91,
  SWAP3 = 0x92,
  SWAP4 = 0x93,
  RETURN = 0xf2,
  REVERT = 0xf0,
  INVALID = 0xfe,
}

export interface EVMContext {
  caller: string;
  address: string;
  value: bigint;
  callData: Uint8Array;
  blockTimestamp: number;
  blockNumber: number;
  gasPrice: bigint;
}

export interface EVMResult {
  ok: boolean;
  gasUsed: bigint;
  output: Uint8Array;
  error?: string;
}

const MAX_STACK = 1024;

export class EVM {
  private stack: Array<bigint> = [];
  private memory = new Uint8Array(0);
  private pc = 0;
  private gasLeft: bigint;
  private readonly maxMemoryBytes = 1 << 20; // 1 MiB dev memory cap

  constructor(
    private readonly journalRef: Journal,
    private readonly code: Uint8Array,
    private readonly ctx: EVMContext,
    gasLimit: bigint,
  ) {
    if (gasLimit > MAX_BLOCK_GAS) throw new Error("gasLimit exceeds dev MAX_BLOCK_GAS");
    this.gasLeft = gasLimit;
  }

  /** Runs the contract. Gas spent is measured relative to this run. */
  run(): EVMResult {
    const gasAtStart = this.gasLeft;
    try {
      const result = this.execute();
      return { ok: true, gasUsed: gasAtStart - this.gasLeft, output: result };
    } catch (err) {
      const withData = err as Error & { revertData?: Uint8Array };
      return {
        ok: false,
        gasUsed: gasAtStart - this.gasLeft,
        output: withData.revertData instanceof Uint8Array ? withData.revertData : new Uint8Array(0),
        error: (err as Error).message,
      };
    }
  }

  get remainingGas(): bigint {
    return this.gasLeft;
  }

  private chargeGas(gas: bigint): void {
    if (gas > this.gasLeft) {
      throw new Error(`out of gas (requested ${gas}, remaining ${this.gasLeft})`);
    }
    this.gasLeft -= gas;
  }

  private execute(): Uint8Array {
    while (this.pc < this.code.length) {
      const op = this.code[this.pc] as OpCode;
      this.pc += 1;
      // PUSH1 (0x60) .. PUSH32 (0x7f): push N following bytes.
      if (op >= 0x60 && op <= 0x7f) {
        const pushLen = op - 0x60 + 1;
        this.chargeGas(MEMORY_OPCODE_GAS);
        const dataStart = this.pc;
        if (dataStart + pushLen > this.code.length) throw new Error("PUSH operand out of code bounds");
        const sliced = this.code.slice(dataStart, dataStart + pushLen);
        this.pc += pushLen;
        this.push(hexBEToBig(padLeft(sliced, 32)));
        continue;
      }
      switch (op) {
        case OpCode.STOP:
          return new Uint8Array(0);
        case OpCode.ADD:
        case OpCode.SUB:
        case OpCode.MUL:
        case OpCode.DIV:
        case OpCode.SDIV:
        case OpCode.MOD:
        case OpCode.LT:
        case OpCode.GT:
        case OpCode.SLT:
        case OpCode.SGT:
        case OpCode.EQ:
        case OpCode.AND:
        case OpCode.OR:
        case OpCode.XOR: {
          this.chargeGas(BASE_OPCODE_GAS);
          const a = this.pop();
          const b = this.pop();
          this.push(this.binaryOp(op, a, b));
          break;
        }
        case OpCode.ISZERO: {
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(this.pop() === 0n ? 1n : 0n);
          break;
        }
        case OpCode.NOT: {
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(u256(this.pop()) ^ u256(2n ** 256n - 1n));
          break;
        }
        case OpCode.ADDMOD:
        case OpCode.MULMOD: {
          this.chargeGas(EXPENSIVE_OPCODE_GAS);
          const a = this.pop();
          const b = this.pop();
          const mod = this.pop();
          if (mod === 0n) this.push(0n);
          else this.push(op === OpCode.ADDMOD ? (a + b) % mod : (a * b) % mod);
          break;
        }
        case OpCode.POP: {
          this.chargeGas(BASE_OPCODE_GAS);
          this.pop();
          break;
        }
        case OpCode.MLOAD:
        case OpCode.MSTORE:
        case OpCode.MSTORE8: {
          this.chargeGas(MEMORY_OPCODE_GAS);
          const offset = this.pop();
          const size = op === OpCode.MSTORE8 ? 1n : 32n;
          this.expandMemory(offset, size);
          if (op === OpCode.MLOAD) {
            this.push(hexBEToBig(this.readMemory(offset, size)));
          } else {
            const value = this.pop();
            this.writeMemory(offset, bigToBytes(value, op === OpCode.MSTORE8 ? 1 : 32));
          }
          break;
        }
        case OpCode.SLOAD: {
          this.chargeGas(STORAGE_GAS);
          const slot = this.pop();
          const value = this.journalRef.getStorage(this.ctx.address, bigToBytes(slot));
          this.push(hexBEToBig(value));
          break;
        }
        case OpCode.SSTORE: {
          this.chargeGas(STORAGE_GAS);
          const slot = this.pop();
          const value = this.pop();
          this.journalRef.setStorage(this.ctx.address, bigToBytes(slot), bigToBytes(value));
          break;
        }
        case OpCode.JUMPDEST: {
          this.chargeGas(BASE_OPCODE_GAS);
          break;
        }
        case OpCode.JUMP: {
          this.chargeGas(BASE_OPCODE_GAS);
          const target = this.pop();
          this.jumpTo(target);
          break;
        }
        case OpCode.JUMPI: {
          this.chargeGas(BASE_OPCODE_GAS);
          const target = this.pop();
          const condition = this.pop();
          if (condition !== 0n) this.jumpTo(target);
          break;
        }
        case OpCode.ADDRESS:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(hexBEToBig(addressToWord(this.ctx.address)));
          break;
        case OpCode.BALANCE:
        case OpCode.SELFBALANCE: {
          this.chargeGas(EXPENSIVE_OPCODE_GAS);
          const account = this.journalRef.getAccount(this.ctx.address);
          this.push(account ? account.balance : 0n);
          break;
        }
        case OpCode.CALLER:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(hexBEToBig(addressToWord(this.ctx.caller)));
          break;
        case OpCode.CALLVALUE:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(this.ctx.value);
          break;
        case OpCode.CALLDATASIZE:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(BigInt(this.ctx.callData.length));
          break;
        case OpCode.CALLDATALOAD: {
          this.chargeGas(MEMORY_OPCODE_GAS);
          const offset = this.pop();
          const value = this.readCallData(offset);
          this.push(hexBEToBig(value));
          break;
        }
        case OpCode.TIMESTAMP:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(BigInt(Math.floor(this.ctx.blockTimestamp)));
          break;
        case OpCode.NUMBER:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(BigInt(this.ctx.blockNumber));
          break;
        case OpCode.GASPRICE:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(this.ctx.gasPrice);
          break;
        case OpCode.GAS:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(this.gasLeft);
          break;
        case OpCode.PC:
          this.chargeGas(BASE_OPCODE_GAS);
          this.push(BigInt(this.pc - 1));
          break;
        case OpCode.INVALID:
          throw new Error("INVALID opcode");
        case OpCode.DUP1:
        case OpCode.DUP2:
        case OpCode.DUP3:
        case OpCode.DUP4:
        case OpCode.DUP5: {
          const n = op - OpCode.DUP1 + 1;
          this.chargeGas(BASE_OPCODE_GAS);
          if (this.stack.length < n) throw new Error("stack underflow");
          this.push(this.stack[this.stack.length - n]);
          break;
        }
        case OpCode.SWAP1:
        case OpCode.SWAP2:
        case OpCode.SWAP3:
        case OpCode.SWAP4: {
          const n = op - OpCode.SWAP1 + 1;
          this.chargeGas(BASE_OPCODE_GAS);
          if (this.stack.length < n + 1) throw new Error("stack underflow");
          const top = this.stack.length - 1;
          const target = top - n;
          const temp = this.stack[top];
          this.stack[top] = this.stack[target];
          this.stack[target] = temp;
          break;
        }
        case OpCode.RETURN:
        case OpCode.REVERT: {
          const offset = this.pop();
          const length = this.pop();
          this.expandMemory(offset, length);
          const output = this.readMemory(offset, length);
          if (op === OpCode.RETURN) return output; // success path
          throwRevert(output);
        }
        default:
          throw new Error(`unsupported opcode 0x${op.toString(16).padStart(2, "0")}`);
      }
    }
    return new Uint8Array(0);
  }

  private push(value: bigint): void {
    if (this.stack.length >= MAX_STACK) throw new Error("stack overflow");
    this.stack.push(u256(value));
  }

  private pop(): bigint {
    if (this.stack.length === 0) throw new Error("stack underflow");
    return this.stack.pop()!;
  }

  private binaryOp(op: OpCode, a: bigint, b: bigint): bigint {
    switch (op) {
      case OpCode.ADD: return a + b;
      case OpCode.SUB: return a - b;
      case OpCode.MUL: return a * b;
      case OpCode.DIV: return b === 0n ? 0n : a / b;
      case OpCode.SDIV: return b === 0n ? 0n : (a / b);
      case OpCode.MOD: return b === 0n ? 0n : a % b;
      case OpCode.LT: return a < b ? 1n : 0n;
      case OpCode.GT: return a > b ? 1n : 0n;
      case OpCode.EQ: return u256(a) === u256(b) ? 1n : 0n;
      case OpCode.AND: return a & b;
      case OpCode.OR: return a | b;
      case OpCode.XOR: return a ^ b;
      case OpCode.SLT: return signed(a) < signed(b) ? 1n : 0n;
      case OpCode.SGT: return signed(a) > signed(b) ? 1n : 0n;
      default: throw new Error(`not a binary op: ${op}`);
    }
  }

  private expandMemory(offset: bigint, length: bigint): void {
    const required = Number(offset + length);
    if (required > this.maxMemoryBytes) {
      throw new Error(`memory access out of dev cap (${required} > ${this.maxMemoryBytes})`);
    }
    if (required > this.memory.length) {
      const next = new Uint8Array(Math.max(required, this.memory.length * 2, 64));
      next.set(this.memory);
      this.memory = next;
    }
  }

  private readMemory(offset: bigint, length: bigint): Uint8Array {
    this.expandMemory(offset, length);
    const start = Number(offset);
    return this.memory.slice(start, start + Number(length));
  }

  private writeMemory(offset: bigint, data: Uint8Array): void {
    this.expandMemory(offset, BigInt(data.length));
    this.memory.set(data, Number(offset));
  }
  private readCallData(offset: bigint): Uint8Array {
    const start = Number(offset);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      if (start + i < this.ctx.callData.length) out[i] = this.ctx.callData[start + i];
    }
    return out;
  }

  private jumpTo(target: bigint): void {
    const t = Number(target);
    if (target > 0xffffffff) throw new Error("jump target out of range");
    if (t >= this.code.length) throw new Error("jump destination out of code bounds");
    if (this.code[t] !== OpCode.JUMPDEST) throw new Error("invalid jump destination");
    this.pc = t;
  }
}

function throwRevert(output: Uint8Array): never {
  const error = new Error("REVERT");
  const revert = error as Error & { revertData: Uint8Array };
  revert.revertData = output;
  throw error;
}

function u256(value: bigint): bigint {
  const mod = 1n << 256n;
  return ((value % mod) + mod) % mod;
}

function signed(value: bigint): bigint {
  const mod = 1n << 256n;
  const wrapped = u256(value);
  return wrapped >= 1n << 255n ? wrapped - mod : wrapped;
}

function bigToBytes(value: bigint, size = 32): Uint8Array {
  return padLeft(beBytes(u256(value)), size);
}

function beBytes(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return fromHex(hex);
}

/** Deterministic contract address: EVM-style CREATE pseudo-address. */
export function contractAddress(sender: string, nonce: bigint): string {
  const bytes = RLP.encode([fromHex(sender), RLP.fromUint(nonce)]);
  const digest = keccak256Hex(bytes);
  return "0x" + digest.slice(2 + 24); // last 20 bytes
}

export function gasCostForCreate(): bigint {
  return CREATE_TX_GAS;
}
