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

| Key / action        | Does                                       |
| ------------------- | ------------------------------------------ |
| `W` `A` `S` `D`     | Walk (relative to the camera)              |
| Drag                | Orbit the camera                           |
| Scroll              | Zoom                                       |
| `E`                 | Interact with the nearest desk             |
| `O`                 | Hold office hours (review who's presenting)|
| `Esc`               | Close a terminal, menu, or review          |

Walk to an empty desk and press `E` to hire a worker; walk to a staffed desk and
press `E` to open its terminal. Inside a terminal, **Send home** frees the desk.

## Presentations & voice review

Agents don't narrate their terminal at you. Instead, when a worker finishes a
chunk of work (or gets blocked), it **writes a report** and walks into your
office to line up and present.

- **Report contract.** A worker drops a JSON file at `$DOMAIN_REPORT_FILE`
  (i.e. `.domain/reports/<desk>.json`). The server watches that folder, turns
  the file into a presentation, and sends the worker to the stage. See the
  auto-generated `.domain/BRIEF.md` for the schema the agent follows.
- **Office hours.** Press `O` and the agent at the podium presents: its summary
  is **read aloud** (a distinct browser voice per agent), with its slides and an
  optional live preview on screen.
- **Voice or text feedback.** Hit 🎤 to dictate (browser speech-to-text) or just
  type. **Approve ▸ continue** lets it carry on; **Send changes** pushes your
  feedback straight back into the agent's session as its next instruction. Then
  the next presenter in line steps up.

All of this uses the **free, browser-native** Web Speech API (so it works out of
the box in the Electron app); no API keys, no per-minute costs.

> The simulated worker exercises this whole loop on its own — hire one, type a
> task, and it will line up to present. Real agents follow the `.domain/BRIEF.md`
> contract (you may need to point your agent at it in its first instruction).

## Layout

```
src/
  shared/protocol.ts     typed client/server messages + office state
  server/
    index.ts             http static server + WebSocket layer
    office.ts            authoritative room state (desks, workers, line, peers)
    workerSession.ts     IWorkerSession interface + backend factory + PATH lookup
    ptyWorker.ts         real local terminal (node-pty) running the agent CLI
    worker.ts            simulated agent session (fallback; drives the demo loop)
    reports.ts           watches .domain/reports for agent presentation files
  client/
    main.ts              glue: loop, interaction, networking, office hours
    net.ts               reconnecting WebSocket client
    voice.ts             browser text-to-speech + speech-to-text (Web Speech API)
    scene/world.ts       toon-shaded scene: room, stage, desks, avatars, peers
    scene/player.ts      WASD movement + orbit camera
    ui/hud.ts            join screen, prompts, hire menu
    ui/terminal.ts       xterm overlay
    ui/review.ts         office-hours presentation + voice/text feedback panel
electron/
  main.ts                desktop shell: starts the server, opens a native window
```

## Roadmap ideas

- ~~Real PTY + agent CLI~~ ✓ · ~~desktop (Electron) app~~ ✓
- ~~Presentations: agents report at a checkpoint and present in your office~~ ✓
- ~~Voice: spoken presentations + dictated feedback~~ ✓
- Auto-brief real agents with the report contract on hire (no manual pointer).
- Worker status detection from real terminals (working / waiting-on-you).
- Auto-launch & embed the project's dev server as a live preview wall.
- GitHub issue/PR boards on the walls; a shared whiteboard; alternate rooms.

## License

MIT
