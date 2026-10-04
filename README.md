# domain

**A 3D room where you walk up to desks and put coding agents to work.**

`domain` is a small multiplayer office you share with your coding agents. Walk
your avatar around a room, step up to an empty desk, and hire a worker — Claude
Code, Codex, OpenCode or Gemini. Each worker's live terminal glows on the laptop
in front of its desk; open it and type. A worker that needs a decision lights a
red beacon over its desk so you can't miss it.

> This is an early foundation, but the terminals are **real**: each worker runs
> in an actual pseudo-terminal on your machine (via `@lydell/node-pty`) that
> launches the agent's CLI in your project directory. If an agent's CLI isn't
> installed, you still get a real local shell. When no terminal backend is
> available at all, it falls back to a **simulated** worker so the app always
> runs. It ships both as a web app and as a native **desktop app** (Electron).

## Stack

- **Client** — TypeScript + [Three.js](https://threejs.org) for the 3D room,
  [xterm.js](https://xtermjs.org) for terminals, bundled with
  [Vite](https://vitejs.dev).
- **Server** — Node + [`ws`](https://github.com/websockets/ws). Holds the
  authoritative office state and streams terminal output to everyone connected.
- **Shared** — one typed message protocol (`src/shared/protocol.ts`) compiled
  into both sides.

## Run it

```bash
npm install
npm run dev
```

This starts the game server on `:8787` and the Vite dev server on `:5173`. Open
**http://localhost:5173**, pick a name, and you're in the room. Open a second
tab to see presence and shared terminals working across clients.

### Production build

```bash
npm run build   # client -> dist/client, server -> dist/server
npm start        # serves the built client and the WebSocket on :8787
```

Then open **http://localhost:8787**.

### Desktop app (Electron)

Run the whole thing as a native window. This starts the embedded server (which
spawns the real local terminals) and opens the office in an Electron window:

```bash
npm run electron        # build everything, then launch the desktop app
npm run electron:dev    # dev: Vite hot reload inside the Electron window
```

The server only ever listens on `127.0.0.1`, so the office — and the terminals
it can spawn — are reachable from your machine alone.

## Real agents vs. simulated

Each worker is a real pseudo-terminal spawned in your project directory:

- If the agent's CLI is on your `PATH` (`claude`, `codex`, `opencode`,
  `gemini`), hiring that agent **launches it** in the terminal.
- If it isn't installed, you still get a real local **shell** at that desk.
- If the native terminal backend can't load (unusual platform), or you set
  `DOMAIN_SIMULATE=1`, the desk runs a **simulated** worker instead.

Useful environment variables:

| Variable           | Does                                                        |
| ------------------ | ----------------------------------------------------------- |
| `PORT`             | Server port (default `8787`).                               |
| `HOST`             | Bind address (default `127.0.0.1`).                         |
| `DOMAIN_CWD`       | Directory real terminals start in (default the server cwd). |
| `DOMAIN_SIMULATE`  | `1` forces simulated workers (no real terminals).           |

> **Security:** anyone who can reach the server can run commands on the host as
> you (that's the point of a local agent office). Keep it on `127.0.0.1`. Do not
> expose it with `--host 0.0.0.0` on an untrusted network.

## Controls

| Key / action        | Does                                   |
| ------------------- | -------------------------------------- |
| `W` `A` `S` `D`     | Walk (relative to the camera)          |
| Drag                | Orbit the camera                       |
| Scroll              | Zoom                                   |
| `E`                 | Interact with the nearest desk         |
| `Esc`               | Close a terminal or menu               |

Walk to an empty desk and press `E` to hire a worker; walk to a staffed desk and
press `E` to open its terminal. Inside a terminal, **Send home** frees the desk.

## Layout

```
src/
  shared/protocol.ts     typed client/server messages + office state
  server/
    index.ts             http static server + WebSocket layer
    office.ts            authoritative room state (desks, workers, peers)
    workerSession.ts     IWorkerSession interface + backend factory + PATH lookup
    ptyWorker.ts         real local terminal (node-pty) running the agent CLI
    worker.ts            simulated agent session (fallback)
  client/
    main.ts              glue: loop, interaction, networking
    net.ts               reconnecting WebSocket client
    scene/world.ts       Three.js scene, room, desks, peers
    scene/player.ts      WASD movement + orbit camera
    ui/hud.ts            join screen, prompts, hire menu
    ui/terminal.ts       xterm overlay
electron/
  main.ts                desktop shell: starts the server, opens a native window
```

## Roadmap ideas

- ~~Real PTY + agent CLI~~ ✓ · ~~desktop (Electron) app~~ ✓
- Worker status detection from real terminals (working / waiting-on-you).
- Voice: push-to-talk dictation into a worker's terminal (browser speech first).
- GitHub issue/PR boards on the walls.
- A shared whiteboard; alternate rooms/themes.

## License

MIT
