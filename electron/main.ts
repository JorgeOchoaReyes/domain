import { app, BrowserWindow, Menu, dialog, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Electron main process.
 *
 * Starts the embedded domain server (which serves the built client and the
 * WebSocket, and spawns real local terminals for workers) and opens it in a
 * native window. The server only ever listens on 127.0.0.1, so the office is
 * reachable from this machine alone.
 *
 * Workers work in a project folder the app works out on its own (see
 * resolveProject); File → Open project folder… (Ctrl+O) switches to another
 * and restarts the app.
 *
 * In development, set DOMAIN_ELECTRON_URL to the Vite dev server (e.g.
 * http://localhost:5173) to get hot reload; the embedded server still runs so
 * the client can reach the WebSocket on :8787.
 */

// Keep everything local to this machine.
process.env.HOST = "127.0.0.1";

// --- which project the workers work in ---------------------------------------------

/**
 * Shared with the server (src/server/prefs.ts): ~/.domain/prefs.json holds the
 * project to open and your recent ones, so switching projects in the game and
 * in the File menu agree.
 */
interface Prefs {
  project?: string;
  recent?: unknown[];
}

const prefsFile = () => process.env.DOMAIN_PREFS || join(homedir(), ".domain", "prefs.json");

function loadPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile(), "utf8")) as Prefs;
  } catch {
    // Earlier versions kept the project in the app's own folder: carry it over.
    try {
      const old = JSON.parse(readFileSync(join(app.getPath("userData"), "prefs.json"), "utf8")) as Prefs;
      return { project: old.project };
    } catch {
      return {};
    }
  }
}

function savePrefs(p: Prefs): void {
  try {
    mkdirSync(dirname(prefsFile()), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(p, null, 2));
  } catch {
    /* best effort */
  }
}

/** Open the office on another project: remember it and restart on it. */
function relaunchOn(path: string): void {
  savePrefs({ ...loadPrefs(), project: path });
  app.relaunch();
  app.exit(0);
}

function isFolder(p: string | undefined): p is string {
  try {
    return !!p && existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function pickProject(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    title: "Choose your project folder",
    buttonLabel: "Work here",
    message: "Your workers open their terminals in this folder (ideally a git repo).",
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/**
 * The folder workers work in, without asking: DOMAIN_CWD if set; else one you
 * chose with File → Open project folder…; else the folder the app was started
 * from (`npm run electron` in your repo); else — an installed app started from
 * a shortcut has no meaningful folder — a workspace of its own in
 * Documents/domain/workspace, made ready for git.
 */
function resolveProject(): string {
  if (isFolder(process.env.DOMAIN_CWD)) return process.env.DOMAIN_CWD;
  const saved = loadPrefs().project;
  if (isFolder(saved)) return saved;
  if (!app.isPackaged && isFolder(process.cwd())) return process.cwd();
  return ensureWorkspace(join(app.getPath("documents"), "domain", "workspace"));
}

/** Make (once) a folder for the workers, as a git repo with a first commit so each can have its own branch. */
function ensureWorkspace(dir: string): string {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", windowsHide: true });
      if (!existsSync(join(dir, "README.md"))) writeFileSync(join(dir, "README.md"), "# My project\n\nBuilt by the team in domain.\n");
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.name=domain", "-c", "user.email=domain@localhost", "commit", "-q", "-m", "Start the project");
    } catch {
      /* no git: workers still work here, just without their own branches */
    }
  }
  return dir;
}

function buildMenu(project: string): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: `Project: ${basename(project)}`, enabled: false },
          {
            label: "Open project folder…",
            accelerator: "CmdOrCtrl+O",
            click: async () => {
              const p = await pickProject();
              if (p && p !== project) relaunchOn(p);
            },
          },
          { label: "Show project folder", click: () => void shell.openPath(project) },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

/**
 * On macOS and Linux an app opened from the Dock or a launcher doesn't get
 * your shell's PATH (Homebrew, npm's global folder, nvm…), so the agent CLIs
 * would look missing. Take PATH from your login shell, as a terminal would.
 */
function loadShellPath(): void {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const out = execFileSync(shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const path = /__PATH__(.*)__PATH__/s.exec(out)?.[1]?.trim();
    if (path) process.env.PATH = [...new Set([...path.split(":"), ...(process.env.PATH ?? "").split(":")])].filter(Boolean).join(":");
  } catch {
    /* keep the PATH we have */
  }
}

async function createWindow(): Promise<void> {
  loadShellPath();
  // Workers need a folder to work in before the server starts.
  const project = resolveProject();
  process.env.DOMAIN_CWD = project;
  buildMenu(project);
  // The usual port, or any free one if something else has it (another app, a dev server).
  if (!process.env.PORT) process.env.PORT = String(await freePort(8787));

  const serverUrl = await startServer();
  const target = process.env.DOMAIN_ELECTRON_URL || serverUrl;

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: "#bfe3ff",
    title: `domain — ${basename(project)}`,
    autoHideMenuBar: true,
    webPreferences: {
      // The page is plain web content talking to the local server over HTTP +
      // WebSocket; it needs no Node access, so keep the renderer sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the project's name in the title (the page would set its own).
  win.on("page-title-updated", (e) => e.preventDefault());

  // Open external links (e.g. GitHub) in the user's real browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // The office is a local page and asks for two things: the microphone (to
  // talk to workers in a review) and the mouse (clicking the game captures it
  // to steer the view). Nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "pointerLock");
  });

  await win.loadURL(target);
}

// --- the office's server -------------------------------------------------------------------

/**
 * The server (every worker's terminal, git, the WebSocket) runs in a
 * background process of its own, so busy terminals or a long git command
 * never hold up this process — which is the one that delivers your keyboard
 * and mouse to the game. It asks this process for the few things only the
 * app can do (the folder picker, restarting on another project) and is told
 * to close up when you quit. If it can't start that way, it runs in here.
 */
let server: UtilityProcess | null = null;

async function startServer(): Promise<string> {
  const entry = fileURLToPath(new URL("../server/server/index.js", import.meta.url));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = utilityProcess.fork(entry, [], { env: { ...process.env }, serviceName: "domain office", stdio: "inherit" });
      const timer = setTimeout(() => reject(new Error("the office's server didn't start in time")), 30_000);
      child.on("message", (m: { t?: string; url?: string; path?: string; id?: number }) => {
        if (m.t === "ready" && m.url) {
          clearTimeout(timer);
          resolve(m.url);
        } else if (m.t === "relaunch" && m.path) {
          const path = m.path;
          setTimeout(() => relaunchOn(path), 600);
        } else if (m.t === "pickFolder") {
          void pickProject().then((path) => child.postMessage({ t: "pickedFolder", id: m.id, path }));
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (server === child) server = null;
        reject(new Error(`the office's server stopped (code ${code})`));
      });
      server = child;
    });
  } catch (e) {
    console.error("Running the office's server in the app instead:", (e as Error).message);
    server?.kill();
    server = null;
    // In here: the same hooks, as globals.
    Object.assign(globalThis, {
      __domainRelaunch: (path: string) => setTimeout(() => relaunchOn(path), 600),
      __domainPickFolder: () => pickProject(),
    });
    // The specifier is held in a variable so TypeScript does not try to
    // resolve the separately-built server bundle at typecheck time.
    const serverEntry = "../server/server/index.js";
    const { serverReady } = (await import(serverEntry)) as { serverReady: Promise<string> };
    return serverReady;
  }
}

/** `preferred` if nothing's listening on it, else a port the system picks. */
function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((done) => {
      const srv = createServer();
      srv.once("error", () => done(null));
      srv.listen(port, "127.0.0.1", () => {
        const got = (srv.address() as { port: number }).port;
        srv.close(() => done(got));
      });
    });
  return tryPort(preferred).then((p) => p ?? tryPort(0).then((q) => q ?? preferred));
}

// One office at a time: opening the app again brings the open window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow).catch((err: Error) => {
    console.error("Failed to start domain:", err);
    dialog.showErrorBox("domain couldn't start", `${err.message}\n\nIf this keeps happening, run it from a terminal (npm run electron) to see the details.`);
    app.quit();
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

// Quitting ends every worker's terminal cleanly (the team is remembered for
// next time): the server is told to close up, and the app waits for it.
let closedUp = false;
app.on("before-quit", (e) => {
  if (closedUp) return;
  const child = server;
  if (!child) {
    closedUp = true;
    try {
      (globalThis as { __domainShutdown?: () => void }).__domainShutdown?.();
    } catch {
      /* quitting anyway */
    }
    return;
  }
  e.preventDefault();
  const done = () => {
    if (closedUp) return;
    closedUp = true;
    app.quit();
  };
  child.once("exit", done);
  child.postMessage({ t: "shutdown" });
  // Don't hang if it doesn't answer.
  setTimeout(() => {
    child.kill();
    done();
  }, 4000);
});

app.on("window-all-closed", () => {
  // Standard macOS behavior: stay alive until Cmd+Q; quit elsewhere.
  if (process.platform !== "darwin") app.quit();
});
