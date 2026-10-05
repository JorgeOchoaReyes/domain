/**
 * When the desktop app runs the server in its own background process (an
 * Electron utility process), the few things only the app can do — show the
 * folder picker, restart on another project — go to it over this channel,
 * and it tells the server to close up when you quit. Elsewhere (npm start, a
 * browser) none of this is here and nothing changes.
 */

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort ?? null;

/** Whether the server is running inside the desktop app's utility process. */
export const inUtilityProcess = port !== null;

let nextId = 0;
const waiting = new Map<number, (path: string | null) => void>();

/**
 * Set up the app's hooks (picker, relaunch) before anything reads them, and
 * hear "shutdown" from the app (close up, then exit). Returns a function that
 * tells the app the server is listening.
 */
export function connectToApp(closeUp: () => void): (url: string) => void {
  if (!port) return () => {};
  Object.assign(globalThis, {
    __domainRelaunch: (path: string) => port.postMessage({ t: "relaunch", path }),
    __domainPickFolder: () =>
      new Promise<string | null>((resolve) => {
        const id = ++nextId;
        waiting.set(id, resolve);
        port.postMessage({ t: "pickFolder", id });
      }),
  });
  port.on("message", (e) => {
    const m = e.data as { t?: string; id?: number; path?: string | null };
    if (m.t === "pickedFolder" && typeof m.id === "number") {
      waiting.get(m.id)?.(m.path ?? null);
      waiting.delete(m.id);
    } else if (m.t === "shutdown") {
      try {
        closeUp();
      } finally {
        // A moment for terminals to finish closing.
        setTimeout(() => process.exit(0), 300);
      }
    }
  });
  return (url) => port.postMessage({ t: "ready", url });
}
