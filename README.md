# domain

**A 3D room where you walk up to desks and put coding agents to work.**

`domain` is a small multiplayer office you share with your coding agents. Walk
your avatar around a room, step up to an empty desk, and hire a worker — Claude
Code, Codex, OpenCode or Gemini. Each worker's live terminal glows on the laptop
in front of its desk; open it and type. A worker that needs a decision lights a
red beacon over its desk so you can't miss it.

> This is an early foundation: a full-stack scaffold with the core loop wired
> end to end. The agents are **simulated** for now — the server fakes each
> terminal session — so the whole thing runs with no agent CLIs installed. The
> worker layer is deliberately shaped so a real PTY-backed agent can be dropped
> in later without touching the room, networking, or client.

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
    worker.ts            simulated agent session (fake terminal)
  client/
    main.ts              glue: loop, interaction, networking
    net.ts               reconnecting WebSocket client
    scene/world.ts       Three.js scene, room, desks, peers
    scene/player.ts      WASD movement + orbit camera
    ui/hud.ts            join screen, prompts, hire menu
    ui/terminal.ts       xterm overlay
```

## Roadmap ideas

- Replace the simulated worker with a real PTY + agent CLI.
- GitHub issue/PR boards on the walls.
- Voice and a shared whiteboard.
- Alternate rooms/themes.

## License

MIT
