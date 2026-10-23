/**
 * World state: account balances, nonces, contract code and contract storage.
 *
 * DEVELOPMENT SIMPLIFICATION (decision D-14 open): the state root is the
 * keccak hash of a canonical JSON serialization of all accounts, rather than
 * a Merkle Patricia Trie. This keeps the reference implementation simple and
 * auditable; replacing it with a persistent authenticated trie is a planned
 * milestone before consensus-relevant releases.
 */
import { keccak256Hex } from "../crypto/hash.js";
import { toHex, fromHex, isHex } from "../util/bytes.js";

export interface Account {
  balance: bigint;
  nonce: bigint;
  /** Contract code (empty for EOAs). */
  code: Uint8Array;
  /** Contract storage: 32-byte slot (hex) -> value word (hex). */
  storage: Map<string, Uint8Array>;
}

export function emptyAccount(): Account {
  return { balance: 0n, nonce: 0n, code: new Uint8Array(0), storage: new Map() };
}

function normalizeAddress(address: string): string {
  if (!isHex(address)) throw new Error(`invalid address: ${address}`);
  const bytes = fromHex(address);
  if (bytes.length !== 20) throw new Error(`address must be 20 bytes, got ${bytes.length}`);
  return address.toLowerCase();
}

function normalizeKey(key: Uint8Array): string {
  return toHex(key).toLowerCase();
}

/**
 * A fork-consistent overlay for transaction execution and EVM revert support.
 * Every mutation is recorded in an undo log so a REVERT can roll back to a
 * specific execution point.
 */
export class Journal {
  private accountOverrides = new Map<string, Account | null>();
  /** address -> slotKey -> {value, prev} */
  private storageOverrides = new Map<string, Map<string, { value: Uint8Array; prev: Uint8Array | null }>>();
  private createdAccounts = new Set<string>();
  private transfers: Array<{ from: string; to: string; value: bigint }> = [];
  private undoLog: Array<() => void> = [];

  constructor(private readonly backing: WorldStateReader) {}

  snapshot(): number {
    return this.undoLog.length;
  }

  /** Restores all state changes created after `point`. */
  restoreTo(point: number): void {
    while (this.undoLog.length > point) {
      this.undoLog.pop()!();
    }
  }

  getAccount(address: string): Account | null {
    const normalized = normalizeAddress(address);
    if (this.accountOverrides.has(normalized)) return this.accountOverrides.get(normalized)!;
    const raw = this.backing.getAccount(normalized);
    const copy = raw ? cloneAccount(raw) : null;
    this.accountOverrides.set(normalized, copy);
    return copy;
  }

  ensureAccount(address: string): Account {
    const normalized = normalizeAddress(address);
    this.createdAccounts.add(normalized);
    const existing = this.getAccount(address);
    if (existing) return existing;
    const fresh = emptyAccount();
    this.accountOverrides.set(normalized, fresh);
    this.undoLog.push(() => {
      this.accountOverrides.set(normalized, null);
      this.createdAccounts.delete(normalized);
    });
    return fresh;
  }

  setAccount(address: string, account: Account | null): void {
    const normalized = normalizeAddress(address);
    this.createdAccounts.add(normalized);
    const had = this.accountOverrides.get(normalized);
    const hadKey = this.accountOverrides.has(normalized);
    this.accountOverrides.set(normalized, account);
    this.undoLog.push(() => {
      if (hadKey) this.accountOverrides.set(normalized, had!);
      else {
        this.accountOverrides.delete(normalized);
        this.createdAccounts.delete(normalized);
      }
    });
  }

  transfer(from: string, to: string, value: bigint): void {
    if (value === 0n) return;
    const fromAcc = this.getAccount(from);
    if (!fromAcc || fromAcc.balance < value) throw new Error("insufficient balance for transfer");
    fromAcc.balance -= value;
    const toAcc = this.ensureAccount(to);
    toAcc.balance += value;
    this.transfers.push({ from: normalizeAddress(from), to: normalizeAddress(to), value });
  }

  /** Contract storage read via the journal, with rollback tracking. */
  getStorage(address: string, slot: Uint8Array): Uint8Array {
    const normalized = normalizeAddress(address);
    const slotKey = normalizeKey(slot);
    const overlay = this.storageOverrides.get(normalized)?.get(slotKey);
    if (overlay) return overlay.value;
    return this.backing.getStorage(normalized, slot);
  }

  setStorage(address: string, slot: Uint8Array, value: Uint8Array): void {
    const normalized = normalizeAddress(address);
    const slotKey = normalizeKey(slot);
    let map = this.storageOverrides.get(normalized);
    if (!map) {
      map = new Map();
      this.storageOverrides.set(normalized, map);
      this.undoLog.push(() => {
        this.storageOverrides.delete(normalized);
      });
    }
    if (!map.has(slotKey)) {
      const prev = this.backing.getStorage(normalized, slot);
      map.set(slotKey, { value, prev });
      this.undoLog.push(() => {
        const m = this.storageOverrides.get(normalized)!;
        const record = m.get(slotKey)!;
        if (record.prev === null) m.delete(slotKey);
        else m.set(slotKey, { value: record.prev, prev: null });
      });
    } else {
      map.get(slotKey)!.value = value;
    }
  }

  touchedAddresses(): string[] {
    return [...new Set([...this.accountOverrides.keys(), ...this.storageOverrides.keys()])];
  }

  /** Commit journal changes into the underlying world state. */
  applyTo(backing: WorldStateWriter): void {
    for (const [address, storage] of this.storageOverrides.entries()) {
      for (const [slotKey, record] of storage.entries()) {
        backing.putStorage(address, fromHex(slotKey), record.value);
      }
    }
    for (const [address, account] of this.accountOverrides.entries()) {
      if (account) backing.putAccount(address, account);
      else backing.deleteAccount(address);
    }
  }
}

export interface WorldStateReader {
  getAccount(address: string): Account | null;
  getStorage(address: string, slot: Uint8Array): Uint8Array;
}

export interface WorldStateWriter {
  putAccount(address: string, account: Account): void;
  deleteAccount(address: string): void;
  putStorage(address: string, slot: Uint8Array, value: Uint8Array): void;
}

export class WorldState implements WorldStateReader, WorldStateWriter {
  private readonly accounts = new Map<string, Account>();

  getAccount(address: string): Account | null {
    return this.accounts.get(normalizeAddress(address)) ?? null;
  }

  getStorage(address: string, slot: Uint8Array): Uint8Array {
    const account = this.getAccount(address);
    if (!account) return new Uint8Array(32);
    const slotKey = normalizeKey(slot);
    if (!account.storage.has(slotKey)) return new Uint8Array(32);
    return account.storage.get(slotKey)!;
  }

  putAccount(address: string, account: Account): void {
    this.accounts.set(normalizeAddress(address), account);
  }

  deleteAccount(address: string): void {
    this.accounts.delete(normalizeAddress(address));
  }

  putStorage(address: string, slot: Uint8Array, value: Uint8Array): void {
    const account = this.getAccount(address) ?? emptyAccount();
    account.storage.set(normalizeKey(slot), value);
    this.putAccount(address, account);
  }

  /** Total BIC supply in base units tracked by this state instance. */
  totalSupply(): bigint {
    let total = 0n;
    for (const account of this.accounts.values()) total += account.balance;
    return total;
  }

  contractCode(address: string): Uint8Array {
    return this.getAccount(address)?.code ?? new Uint8Array(0);
  }

  serialize(): string {
    const sorted = [...this.accounts.keys()].sort();
    const payload = sorted.map((address) => {
      const account = this.accounts.get(address)!;
      const slots = [...account.storage.keys()].sort().map((slot) => [slot, toHex(account.storage.get(slot)!)]);
      return [
        address,
        account.balance.toString(16),
        account.nonce.toString(16),
        toHex(account.code),
        slots,
      ];
    });
    return JSON.stringify(payload);
  }

  stateRoot(): string {
    return keccak256Hex(new TextEncoder().encode(this.serialize()));
  }

  /** Deep copy, O(accounts). Used to checkpoint state for fork handling. */
  clone(): WorldState {
    const out = new WorldState();
    for (const [address, account] of this.accounts.entries()) {
      out.putAccount(address, cloneAccount(account));
    }
    return out;
  }

  static fromSerialized(json: string): WorldState {
    const state = new WorldState();
    for (const [address, balance, nonce, code, slots] of JSON.parse(json) as Array<[string, string, string, string, Array<[string, string]>]>) {
      const account = emptyAccount();
      account.balance = BigInt("0x" + balance);
      account.nonce = BigInt("0x" + nonce);
      account.code = fromHex(code);
      for (const [slot, value] of slots) {
        account.storage.set(slot.toLowerCase(), fromHex(value));
      }
      state.putAccount(address, account);
    }
    return state;
  }

  static fromGenesisAllocations(allocations: Array<{ address: string; balance: bigint }>): WorldState {
    const state = new WorldState();
    for (const { address, balance } of allocations) {
      state.getAccount(address);
      const account = emptyAccount();
      account.balance = balance;
      state.putAccount(address, account);
    }
    return state;
  }
}

function cloneAccount(account: Account): Account {
  return {
    balance: account.balance,
    nonce: account.nonce,
    code: new Uint8Array(account.code),
    storage: new Map([...account.storage.entries()].map(([k, v]) => [k, new Uint8Array(v)])),
  };
}
