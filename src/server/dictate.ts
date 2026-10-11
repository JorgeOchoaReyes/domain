import { spawn as nodeSpawn } from "node:child_process";

/**
 * Dictation in the desktop app. Its built-in browser has no speech service,
 * so the 🎤 button asks for the computer's own dictation instead:
 *
 * - Windows: this presses Win+H (which opens voice typing — or closes it, the
 *   second time), and Windows types what you say into the box that has focus.
 *   One hidden PowerShell stays up after the first press (each press is one
 *   line to it, answered with a line back once the keys are down and up), so
 *   the next ones are instant.
 * - macOS: the desktop app starts dictation itself (see electron/dictation.ts);
 *   the server only passes the request on, through the hook the app leaves.
 *
 * Every press is answered: whether dictation was started and, if not, why —
 * so the 🎤 button can say how to start it by hand instead.
 */

export interface DictateResult {
  ok: boolean;
  /** Why not, in words for the person at the desk. */
  error?: string;
}

/** The part of a child process this uses (so tests can stand in for PowerShell). */
export interface Helper {
  readonly exitCode: number | null;
  readonly killed: boolean;
  stdin: { write(s: string): unknown };
  stdout: { on(e: "data", f: (chunk: Buffer | string) => void): unknown };
  stderr: { on(e: "data", f: (chunk: Buffer | string) => void): unknown };
  on(e: "exit" | "error", f: (...a: unknown[]) => void): unknown;
  kill(): unknown;
}

export interface DictateDeps {
  platform: NodeJS.Platform;
  /** Start the hidden PowerShell (Windows). */
  spawn: () => Helper;
  /** The desktop app's own dictation (macOS), if the server runs inside the app. */
  askApp: () => ((() => Promise<DictateResult>) | null);
  /** How long to wait for PowerShell to say it pressed the keys (the first press compiles a little C#). */
  timeoutMs: number;
}

const SETUP = `Add-Type -Namespace DomainKeys -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'`;
/** Win down, H down, H up, Win up — then say so. */
export const WIN_H =
  "[DomainKeys.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [DomainKeys.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero); [DomainKeys.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [DomainKeys.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero); 'pressed'";

const HINT = {
  win32: "Couldn't start Windows voice typing — press Win + H",
  darwin: "Couldn't start dictation — press Fn twice (or 🌐 D)",
};

export function dictation(deps: DictateDeps) {
  let helper: Helper | null = null;
  /** Presses waiting for PowerShell's "pressed", oldest first. */
  let pending: ((r: DictateResult) => void)[] = [];
  let failed = "";

  const settle = (r: DictateResult) => {
    const done = pending;
    pending = [];
    for (const f of done) f(r);
  };

  const startHelper = (): Helper => {
    const p = deps.spawn();
    let out = "";
    p.stdout.on("data", (chunk) => {
      out += String(chunk);
      let i: number;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (line === "pressed") pending.shift()?.({ ok: true });
      }
    });
    // PowerShell can't add the key-pressing code (locked-down machines): say so, don't wait.
    p.stderr.on("data", (chunk) => {
      failed = String(chunk).trim().split(/\r?\n/)[0] ?? "";
      if (failed) settle({ ok: false, error: HINT.win32 });
    });
    const gone = () => {
      if (helper === p) helper = null;
      settle({ ok: false, error: HINT.win32 });
    };
    p.on("exit", gone);
    p.on("error", gone);
    p.stdin.write(SETUP + "\n");
    return p;
  };

  const pressWinH = (): Promise<DictateResult> =>
    new Promise((resolve) => {
      if (!helper || helper.exitCode !== null || helper.killed) helper = startHelper();
      let answered = false;
      const answer = (r: DictateResult) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        pending = pending.filter((f) => f !== answer);
        answer({ ok: false, error: HINT.win32 });
      }, deps.timeoutMs);
      pending.push(answer);
      try {
        helper.stdin.write(WIN_H + "\n");
      } catch {
        settle({ ok: false, error: HINT.win32 });
      }
    });

  return {
    /** Whether this computer can start dictation from the 🎤 button. */
    canDictate(): boolean {
      return deps.platform === "win32" || (deps.platform === "darwin" && deps.askApp() !== null);
    },
    /** Start (on Windows: or stop) the computer's dictation in whatever has focus. */
    async toggle(): Promise<DictateResult> {
      if (deps.platform === "win32") return pressWinH();
      if (deps.platform === "darwin") {
        const ask = deps.askApp();
        if (!ask) return { ok: false, error: "Press Fn twice (or 🌐 D) to dictate" };
        try {
          return await ask();
        } catch {
          return { ok: false, error: HINT.darwin };
        }
      }
      return { ok: false, error: "Use your computer's dictation to talk" };
    },
    /** What went wrong last on Windows, as PowerShell said it (for the log). */
    get lastError(): string {
      return failed;
    },
    stop(): void {
      helper?.kill();
      helper = null;
      settle({ ok: false, error: "stopped" });
    },
  };
}

const real = dictation({
  platform: process.platform,
  spawn: () =>
    nodeSpawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true }),
  // Set by parentPort.ts (the app's utility process) or by the app itself (server in-process).
  askApp: () => (globalThis as { __domainDictate?: () => Promise<DictateResult> }).__domainDictate ?? null,
  timeoutMs: 8000,
});

/** Whether this computer can start dictation from the 🎤 button. */
export const canDictate = (): boolean => real.canDictate();
/** Press Win+H (Windows) or ask the app to start dictation (macOS). */
export const toggleDictation = (): Promise<DictateResult> => real.toggle();
export const stopDictationHelper = (): void => real.stop();
