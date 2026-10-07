import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Dictation in the desktop app. Its built-in browser has no speech service,
 * so the 🎤 button asks for Windows' own voice typing instead: this presses
 * Win+H (which opens it — or closes it, the second time), and Windows types
 * what you say into the box that has focus. One hidden PowerShell stays up
 * after the first press (each press is one line to it), so the next ones are
 * instant.
 */

const SETUP = `Add-Type -Namespace DomainKeys -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'`;
/** Win down, H down, H up, Win up. */
const WIN_H = "[DomainKeys.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [DomainKeys.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero); [DomainKeys.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [DomainKeys.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)";

let helper: ChildProcessWithoutNullStreams | null = null;

/** Whether this computer can do it (Windows only: elsewhere the button says how to start the OS's dictation). */
export function canDictate(): boolean {
  return process.platform === "win32";
}

/** Press Win+H: Windows voice typing starts (or stops) in whatever has focus. */
export function toggleDictation(): boolean {
  if (!canDictate()) return false;
  if (!helper || helper.exitCode !== null || helper.killed) {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true });
    p.on("exit", () => helper === p && (helper = null));
    p.on("error", () => helper === p && (helper = null));
    p.stdout.resume();
    p.stderr.resume();
    p.stdin.write(SETUP + "\n");
    helper = p;
  }
  helper.stdin.write(WIN_H + "\n");
  return true;
}

export function stopDictationHelper(): void {
  helper?.kill();
  helper = null;
}
