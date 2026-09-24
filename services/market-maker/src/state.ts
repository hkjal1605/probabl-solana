import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface MarketState {
  peak?: string;
  halted?: boolean;
  fundStarted?: boolean;
  fundComplete?: boolean;
  spot?: string;
  probability?: string;
  observedAt?: number;
  movement?: string;
  movementAt?: number;
  cooldownUntil?: number;
  /** Unit of `spot`: quote raw per share unit x 1e18. Absent on legacy checkpoints. */
  priceUnit?: "share";
}
export interface State {
  version: 1;
  scope: string;
  day: string;
  spent: string;
  lastSlot: number;
  pending?: { signature: string; lastValidBlockHeight: number };
  markets: Record<string, MarketState>;
}
export function initialState(scope: string): State {
  return {
    version: 1,
    scope,
    day: new Date().toISOString().slice(0, 10),
    spent: "0",
    lastSlot: 0,
    markets: {},
  };
}
export function validateState(value: unknown, scope: string): State {
  const s = value as State;
  const integer = (v: unknown) => typeof v === "string" && /^[0-9]{1,80}$/.test(v);
  if (
    !s ||
    s.version !== 1 ||
    s.scope !== scope ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s.day) ||
    !integer(s.spent) ||
    !Number.isSafeInteger(s.lastSlot) ||
    s.lastSlot < 0 ||
    !s.markets ||
    typeof s.markets !== "object" ||
    Array.isArray(s.markets)
  )
    throw new Error("Invalid bot state; do not silently reset risk limits");
  if (
    s.pending &&
    (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s.pending.signature) ||
      !Number.isSafeInteger(s.pending.lastValidBlockHeight) ||
      s.pending.lastValidBlockHeight <= 0)
  )
    throw new Error("Invalid pending transaction journal");
  for (const m of Object.values(s.markets)) {
    if (!m || typeof m !== "object") throw new Error("Invalid market state");
    for (const v of [m.peak, m.spot, m.probability, m.movement])
      if (v !== undefined && !integer(v)) throw new Error("Invalid risk checkpoint");
    for (const v of [m.halted, m.fundStarted, m.fundComplete])
      if (v !== undefined && typeof v !== "boolean") throw new Error("Invalid safety latch");
    if (m.priceUnit !== undefined && m.priceUnit !== "share")
      throw new Error("Invalid price unit checkpoint");
    for (const v of [m.observedAt, m.cooldownUntil, m.movementAt])
      if (v !== undefined && (!Number.isSafeInteger(v) || v < 0))
        throw new Error("Invalid risk time");
  }
  return s;
}
/** One host/one dedicated wallet. Atomic, fsynced state is saved BEFORE signing is broadcast. */
export class StateFile {
  readonly path: string;
  readonly lock: string;
  state: State;
  constructor(path: string, scope: string) {
    this.path = resolve(path);
    this.lock = this.path + ".lock";
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const directory = lstatSync(dirname(this.path));
    if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o077) !== 0)
      throw new Error("State directory must be private");
    if (existsSync(this.lock)) {
      const info = lstatSync(this.lock);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid bot lock");
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid bot lock PID");
      try {
        process.kill(pid, 0);
        throw new Error("Another bot process holds this state");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      if (existsSync(this.path)) {
        const info = lstatSync(this.path);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
          throw new Error("State file must be private");
        this.state = validateState(JSON.parse(readFileSync(this.path, "utf8")), scope);
      } else {
        this.state = initialState(scope);
      }
      // An interrupted pre-broadcast checkpoint is never silently adopted or overwritten.
      if (existsSync(this.path + ".next"))
        renameSync(this.path + ".next", this.path + `.abandoned-${Date.now()}`);
      this.save();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  save() {
    const next = this.path + ".next";
    const fd = openSync(next, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(next, this.path);
    chmodSync(this.path, 0o600);
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  close() {
    if (existsSync(this.lock)) unlinkSync(this.lock);
  }
}
