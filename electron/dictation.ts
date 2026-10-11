/**
 * The 🎤 button on macOS, in the desktop app: start the Mac's own dictation
 * in the box that has focus, the way Edit → Start Dictation… does — by
 * sending `startDictation:` to the window's first responder. That needs no
 * extra permission (no Accessibility, no AppleScript), unlike pressing keys.
 *
 * It can't start dictation that's turned off, and macOS doesn't say whether
 * it started; so the answer is "no" (with how to turn it on) when the Mac's
 * settings say dictation is off, or when sending fails, and the 🎤 button
 * then says how to start it by hand.
 *
 * Kept free of Electron imports so it can be tested anywhere.
 */

export interface DictateResult {
  ok: boolean;
  error?: string;
}

export interface MacDictationDeps {
  /** Menu.sendActionToFirstResponder. */
  sendAction: (action: string) => void;
  /** `defaults read <domain> <key>`, or null when unset/unreadable. */
  readDefault: (domain: string, key: string) => Promise<string | null>;
}

export const DICTATION_OFF = "Dictation is off — turn it on in System Settings → Keyboard → Dictation, then press 🎤 again";
export const DICTATION_FAILED = "Couldn't start dictation — press Fn twice (or 🌐 D), or use Edit → Start Dictation…";

/** Start dictation (macOS). */
export async function startMacDictation(deps: MacDictationDeps): Promise<DictateResult> {
  // 1 = on, 0 = off; unset on Macs where it was never touched (try anyway).
  let enabled: string | null = null;
  try {
    enabled = await deps.readDefault("com.apple.HIToolbox", "AppleDictationAutoEnable");
  } catch {
    enabled = null;
  }
  if (enabled?.trim() === "0") return { ok: false, error: DICTATION_OFF };
  try {
    deps.sendAction("startDictation:");
    return { ok: true };
  } catch {
    return { ok: false, error: DICTATION_FAILED };
  }
}

/** `defaults read`, through any execFile (the real one in the app, a stand-in in tests). */
export function defaultsReader(
  execFile: (cmd: string, args: string[], opts: { timeout: number }, cb: (err: Error | null, stdout: string) => void) => unknown,
): MacDictationDeps["readDefault"] {
  return (domain, key) =>
    new Promise((resolve) => {
      try {
        execFile("/usr/bin/defaults", ["read", domain, key], { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
      } catch {
        resolve(null);
      }
    });
}
