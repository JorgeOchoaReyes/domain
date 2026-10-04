import { defineConfig } from "vite";

// The client is a plain TypeScript + Three.js app. In dev, Vite serves it on
// 5173 and the game server runs separately on 8787 (the client connects to it
// over a WebSocket). In production, `npm run build` emits the client into
// dist/client and the server serves those static files itself.
export default defineConfig({
  root: "src/client",
  publicDir: "public",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // three.js and xterm change rarely: their own chunks cache across releases.
        manualChunks: { three: ["three"], xterm: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/headless"] },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
