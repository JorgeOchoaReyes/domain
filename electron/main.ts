import { app, BrowserWindow, shell } from "electron";

/**
 * Electron main process.
 *
 * Starts the embedded domain server (which serves the built client and the
 * WebSocket, and spawns real local terminals for workers) and opens it in a
 * native window. The server only ever listens on 127.0.0.1, so the office is
 * reachable from this machine alone.
 *
 * In development, set DOMAIN_ELECTRON_URL to the Vite dev server (e.g.
 * http://localhost:5173) to get hot reload; the embedded server still runs so
 * the client can reach the WebSocket on :8787.
 */

// Keep everything local to this machine.
process.env.HOST = "127.0.0.1";

async function createWindow(): Promise<void> {
  // Importing the server starts it listening; serverReady resolves with the
  // URL. The specifier is held in a variable so TypeScript does not try to
  // resolve the separately-built server bundle at typecheck time.
  const serverEntry = "../server/server/index.js";
  const { serverReady } = (await import(serverEntry)) as { serverReady: Promise<string> };
  const serverUrl = await serverReady;
  const target = process.env.DOMAIN_ELECTRON_URL || serverUrl;

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: "#0b0d12",
    title: "domain",
    autoHideMenuBar: true,
    webPreferences: {
      // The page is plain web content talking to the local server over HTTP +
      // WebSocket; it needs no Node access, so keep the renderer sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links (e.g. GitHub) in the user's real browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  await win.loadURL(target);
}

app.whenReady().then(createWindow).catch((err) => {
  console.error("Failed to start domain:", err);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  // Standard macOS behavior: stay alive until Cmd+Q; quit elsewhere.
  if (process.platform !== "darwin") app.quit();
});
