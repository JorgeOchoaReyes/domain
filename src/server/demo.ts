import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalDemo } from "../shared/huddle.js";

/**
 * The demo at the end of a goal: when every task of a build goal is
 * approved, the office captures what was built and shows it to everyone
 * before it ships — a screenshot of the running app taken by a headless
 * Chrome (or Edge), or, for anything without a page to look at, the output
 * of a command run in the project folder.
 *
 * What to capture, first that applies:
 *   "demo" in domain.config.json (or DOMAIN_DEMO): a URL to screenshot, or a command to run
 *   "preview": the project's preview URL
 *   a dev server running on this machine
 *   "check": the project's check (e.g. `npm test`), as a captured terminal run
 * `"huddle": false` in the same file turns the team huddle off.
 */

export interface DemoSettings {
  demo: string | null;
  preview: string | null;
  check: string | null;
  /** Whether goals start with a team huddle on the plan. */
  huddle: boolean;
}

/** The demo and huddle settings, read fresh from domain.config.json (with env overrides). */
export function loadDemoSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): DemoSettings {
  let file: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "domain.config.json"), "utf8")) as unknown;
    if (raw && typeof raw === "object") file = raw as Record<string, unknown>;
  } catch {
    /* no config, or unreadable */
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 1000) : null);
  const preview = str(env.DOMAIN_PREVIEW_URL) ?? str(file.preview);
  const off = env.DOMAIN_HUDDLE === "0" || env.DOMAIN_HUDDLE === "off" || file.huddle === false;
  return {
    demo: str(env.DOMAIN_DEMO) ?? str(file.demo),
    preview: preview && /^https?:\/\//i.test(preview) ? preview : null,
    check: str(env.DOMAIN_CHECK_CMD) ?? str(file.check),
    huddle: !off,
  };
}

export type DemoPlan = { kind: "screenshot"; url: string } | { kind: "terminal"; command: string };

/** What the demo will show (null: nothing to capture — set "demo" in domain.config.json). */
export function demoPlan(s: Pick<DemoSettings, "demo" | "preview" | "check">, devServers: string[] = []): DemoPlan | null {
  if (s.demo) return /^https?:\/\//i.test(s.demo) ? { kind: "screenshot", url: s.demo } : { kind: "terminal", command: s.demo };
  if (s.preview) return { kind: "screenshot", url: s.preview };
  if (devServers[0]) return { kind: "screenshot", url: devServers[0] };
  if (s.check) return { kind: "terminal", command: s.check };
  return null;
}

/** A Chrome, Edge or Chromium on this machine for screenshots: DOMAIN_BROWSER (or CHROME) first. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform = process.platform): string | null {
  for (const v of [env.DOMAIN_BROWSER, env.CHROME]) if (v && exists(v)) return v;
  const candidates: string[] = [];
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA, "C:/Program Files", "C:/Program Files (x86)"]) {
      if (!base) continue;
      candidates.push(join(base, "Google/Chrome/Application/chrome.exe"), join(base, "Microsoft/Edge/Application/msedge.exe"), join(base, "Chromium/Application/chrome.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    for (const dir of (env.PATH ?? "/usr/bin:/usr/local/bin").split(":")) {
      for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) candidates.push(join(dir, name));
    }
  }
  return candidates.find((p) => exists(p)) ?? null;
}

/** The arguments that have a headless browser save a screenshot of `url` to `out`. */
export function screenshotArgs(url: string, out: string, profile: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    "--window-size=1280,800",
    // Let the page settle (scripts, fonts, a first fetch) before the picture.
    "--virtual-time-budget=5000",
    `--screenshot=${out}`,
    url,
  ];
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** Run a program, keeping the end of what it prints; killed when it runs over. */
export function runFor(file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; verbatim?: boolean }): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const keep = (b: Buffer) => {
      output = (output + b.toString()).slice(-64_000);
    };
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsVerbatimArguments: opts.verbatim, windowsHide: true });
    } catch (err) {
      resolve({ code: null, output: (err as Error).message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => (output += `\n${err.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: strip(output), timedOut });
    });
  });
}

/**
 * Capture a demo. A screenshot is saved to `png`; a terminal run keeps the
 * end of its output. Never throws: a failure is a demo that says what went wrong.
 */
export async function captureDemo(plan: DemoPlan, opts: { cwd: string; png: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; browser?: string | null }): Promise<GoalDemo> {
  const at = Date.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (plan.kind === "screenshot") {
    const browser = opts.browser === undefined ? findBrowser(opts.env) : opts.browser;
    const base: GoalDemo = { kind: "screenshot", status: "failed", source: plan.url, output: "", image: false, exitCode: null, at };
    if (!browser) return { ...base, output: "No Chrome, Edge or Chromium found for the screenshot — set DOMAIN_BROWSER to one, or a \"demo\" command in domain.config.json." };
    rmSync(opts.png, { force: true });
    mkdirSync(join(opts.png, ".."), { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "domain-demo-"));
    try {
      const r = await runFor(browser, screenshotArgs(plan.url, opts.png, profile), { cwd: opts.cwd, timeoutMs, env: opts.env });
      const ok = existsSync(opts.png) && statSync(opts.png).size > 0;
      return { ...base, status: ok ? "ready" : "failed", image: ok, exitCode: r.code, output: ok ? "" : (r.timedOut ? "The browser took too long. " : "") + r.output.slice(-2000) };
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  const win = process.platform === "win32";
  const file = win ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
  const args = win ? ["/d", "/s", "/c", plan.command] : ["-lc", plan.command];
  const r = await runFor(file, args, { cwd: opts.cwd, timeoutMs, env: { ...(opts.env ?? process.env), DOMAIN_DEMO: "1", CI: "1" }, verbatim: win });
  const tail = r.output.trimEnd().slice(-8000) + (r.timedOut ? `\n▸ stopped after ${Math.round(timeoutMs / 1000)}s` : "");
  return { kind: "terminal", status: r.code === 0 ? "ready" : "failed", source: plan.command, output: tail, image: false, exitCode: r.code, at };
}

/** A screenshot as a data URL, for sending to the office (null if there's none, or it's too big). */
export function demoImage(png: string, max = 6 * 1024 * 1024): string | null {
  try {
    if (!existsSync(png) || statSync(png).size > max) return null;
    return `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  } catch {
    return null;
  }
}

/** DOMAIN_SIMULATE: a demo that looks like a test run. */
export function simDemo(title: string): GoalDemo {
  const output = [
    "$ npm test (simulated)",
    "",
    `▸ ${title}`,
    "  ✔ the core flow works end to end (212 ms)",
    "  ✔ handles the empty case (8 ms)",
    "  ✔ shows a clear error when the network is down (31 ms)",
    "",
    "ℹ tests 42 · pass 42 · fail 0",
  ].join("\n");
  return { kind: "terminal", status: "ready", source: "npm test (simulated)", output, image: false, exitCode: 0, at: Date.now() };
}
