import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the running office is listening, for the command line (nou) to find
 * it: the desktop app picks a free port, so it can't just assume 8787.
 * Written when the office starts listening, removed when it closes.
 */

export interface OfficeAddress {
  port: number;
  host: string;
  pid: number;
  /** The project folder it's working in. */
  project: string;
  startedAt: number;
}

export function officeAddressPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOMAIN_ADDRESS || join(homedir(), ".domain", "office.json");
}

export function writeOfficeAddress(a: OfficeAddress, file = officeAddressPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(a, null, 2));
  } catch {
    /* best effort: nou falls back to the default port */
  }
}

export function readOfficeAddress(file = officeAddressPath()): OfficeAddress | null {
  try {
    const a = JSON.parse(readFileSync(file, "utf8")) as Partial<OfficeAddress>;
    return typeof a.port === "number" ? { port: a.port, host: a.host ?? "127.0.0.1", pid: a.pid ?? 0, project: a.project ?? "", startedAt: a.startedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

/** The office closed: forget its address (only if it's still ours). */
export function clearOfficeAddress(pid: number, file = officeAddressPath()): void {
  if (readOfficeAddress(file)?.pid === pid) rmSync(file, { force: true });
}
