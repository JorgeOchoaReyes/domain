import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { VERSION_RE } from "../shared/agents.js";
import type { RecentProject } from "../shared/project.js";

/**
 * Your preferences across projects, in ~/.domain/prefs.json (DOMAIN_PREFS
 * overrides the path): the project the desktop app opens on, and the ones
 * you've worked on recently. The desktop app reads the same file to decide
 * where to start, so switching projects in the game sticks.
 */

export interface Prefs {
  /** The project to open next time (set when you switch in the game or the File menu). */
  project?: string;
  recent: RecentProject[];
  /** The GitHub account you last signed in as (the credential manager may hold several). */
  githubLogin?: string;
  /** Projects whose worker folders agents may trust without asking you each time. */
  trusted?: string[];
  /** Agent CLI versions you've said to stay on (an update broke something). */
  pins?: Record<string, string>;
}

export const MAX_RECENT = 12;

export function prefsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOMAIN_PREFS || join(homedir(), ".domain", "prefs.json");
}

export function loadPrefs(file = prefsPath()): Prefs {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Prefs>;
    const recent = Array.isArray(raw.recent)
      ? raw.recent.filter(
          (r): r is RecentProject =>
            !!r && typeof r.path === "string" && typeof r.name === "string" && typeof r.openedAt === "number",
        )
      : [];
    const login = typeof raw.githubLogin === "string" && /^[A-Za-z0-9-]{1,39}$/.test(raw.githubLogin) ? raw.githubLogin : undefined;
    const trusted = Array.isArray(raw.trusted) ? raw.trusted.filter((t): t is string => typeof t === "string").slice(0, 100) : [];
    const pins = Object.fromEntries(
      Object.entries(raw.pins && typeof raw.pins === "object" ? raw.pins : {}).filter(([k, v]) => /^[a-z]{1,20}$/.test(k) && typeof v === "string" && VERSION_RE.test(v)),
    );
    return {
      project: typeof raw.project === "string" ? raw.project : undefined,
      recent: recent.slice(0, MAX_RECENT),
      ...(login ? { githubLogin: login } : {}),
      ...(trusted.length ? { trusted } : {}),
      ...(Object.keys(pins).length ? { pins } : {}),
    };
  } catch {
    return { recent: [] };
  }
}

export function savePrefs(p: Prefs, file = prefsPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(p, null, 2));
    renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

/** Two paths name the same folder (case-insensitive on Windows and macOS). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "linux" ? r : r.toLowerCase();
  };
  return norm(a) === norm(b);
}

/**
 * Put a project at the top of the recent list (once), newest first, keeping
 * at most MAX_RECENT. With `current`, it's also the one to open next time.
 */
export function rememberProject(
  path: string,
  github: string | null,
  opts: { current?: boolean; file?: string; now?: number } = {},
): Prefs {
  const file = opts.file ?? prefsPath();
  const p = loadPrefs(file);
  const entry: RecentProject = { path: resolve(path), name: basename(resolve(path)), github, openedAt: opts.now ?? Date.now() };
  p.recent = [entry, ...p.recent.filter((r) => !samePath(r.path, path))].slice(0, MAX_RECENT);
  if (opts.current) p.project = entry.path;
  savePrefs(p, file);
  return p;
}

/** Whether you've trusted this project's worker folders. */
export function isTrusted(project: string, file = prefsPath()): boolean {
  return (loadPrefs(file).trusted ?? []).some((t) => samePath(t, project));
}

/** Trust this project's worker folders from now on. */
export function trustProject(project: string, file = prefsPath()): void {
  const p = loadPrefs(file);
  if ((p.trusted ?? []).some((t) => samePath(t, project))) return;
  savePrefs({ ...p, trusted: [...(p.trusted ?? []), project] }, file);
}

/** Stay on a version of an agent CLI (null: follow the newest again). */
export function pinAgent(agent: string, version: string | null, file = prefsPath()): void {
  const p = loadPrefs(file);
  const pins = { ...(p.pins ?? {}) };
  if (version) pins[agent] = version;
  else delete pins[agent];
  savePrefs({ ...p, pins }, file);
}
