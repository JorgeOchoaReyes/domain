# domain

**A 3D office where you put coding agents to work — and turn real progress into a game.**

![The work floor: workers at their desks, the quest tracker, the session timer and the minimap](docs/screenshots/work-floor.jpg)

Walk around a cartoon office, sit a worker at a desk — Claude Code, Codex,
OpenCode or Gemini CLI, on the model you choose, local ones included — and hand
it a task. Each worker runs in a real terminal on your machine, on its own git
branch, and its live screen glows on the laptop in front of it. When you want
to see how everyone's doing, **round them up**: they stop to put together a
progress report, get checked by your tests, line up outside **your office** and
come in one at a time to present a slide deck, out loud. Approve the work and it
merges into your branch; send it back and your notes go straight into its CLI.

It's built to make work fun without faking it: every session starts with a
**stand-up**, every goal moves through one loop — plan, build, review, ship — and
XP, levels, streaks and achievements only come from things that actually move
the work forward. While the workers grind, there's a game room, a kitchen and a
whole campus to walk around in. Got an idea? Sketch it on a whiteboard and hand
it to a worker. Got a headset? Step in with **VR**.

## Get started

### What you need

- **Node.js 20+** (it brings npm, which installs the agents) and **git**.
- **An agent CLI**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  (`claude`), [Codex](https://github.com/openai/codex) (`codex`),
  [OpenCode](https://opencode.ai) (`opencode`) or
  [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`). Don't
  have one? The office installs it for you: the hire card shows **⬇ Install**
  next to any that's missing (it runs `npm install -g …`, with the output in
  Logs), and Arnold offers Claude Code on your first visit. Sign in to it the way
  you normally would the first time it runs. No agents at all? Try
  [simulate mode](#try-it-without-any-agents).
- Optional: [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai)
  for [local models](#agents-and-models).
- Windows, macOS or Linux.

### Install the app

**Windows:** build the installer once and run it —

```bash
git clone <this repo> domain && cd domain
npm install
npm run dist          # → release/domain-setup-0.1.0.exe
```

Double-click `release/domain-setup-0.1.0.exe`: it installs for you (no admin
rights needed), adds **domain** to the Start menu and the desktop, and opens
it. `npm run dist` builds a `.dmg` on macOS and an `.AppImage` on Linux the same
way. The installer isn't code-signed yet, so Windows SmartScreen may ask you to
confirm (**More info → Run anyway**).

### Or run it from the source

```bash
git clone <this repo> domain && cd domain
npm install
npm run electron
```

That's it — the office opens. Only one office runs at a time (opening it again
brings the window forward), and if something else already uses port 8787 it
picks a free port by itself. Your workers work in the folder you started it
from. (Started from a shortcut instead, it makes a workspace of its own in
`Documents/domain/workspace`, ready for git.) To put them on a different
project, **File → Open project folder… (Ctrl+O)**.

### Your first five minutes

1. **Pick your character** and walk in. **Arnold**, your assistant, says hi and
   offers a two-minute **guided tour** of the office — take it.
2. **Hold the stand-up**: set today's goal (or start from a template), pick a
   **tone** for the session, say what would make it a win, choose a length,
   **Start the day**.
3. **Click the view** to play (the mouse hides and steers; **Tab** frees it).
   Press **T → Work floor**, walk to a desk with a green **+** and press **E**
   to **hire** a worker — pick the agent and its model.
4. Open **Goals** (**G**): no tasks yet? **Plan with a worker** and its checklist
   appears on its own. Hand out a task — the **assignment card** sets the model,
   a time budget, plan-first and what "done" means.
5. Watch it work on its laptop, or on yours (**L**) — or go play in the
   **game room** (**T**); you'll get a shout when a worker needs you.
6. **Round up** (**R**) and hold **office hours** (**O**): each worker presents,
   you approve it (it merges into your branch) or send back changes.
7. When every task is done, **Ship it**.

The **goal card** under your player card always shows the goal, how far
along it is, where it is in the loop and the one next step — click it to do
that step. **Arnold** (bottom left) speaks up when something needs you: a worker
waiting on your answer, work ready to review, the session about to end. Click
Arnold any time to ask what's next, take the tour again, or have Arnold **walk you
through** something — *start a focus session*, *put a worker on a task*, *ship a
pull request*, *hand off an idea*. Each is a short checklist that ticks itself
off as you go, with a button on every step that does it for you.

![Arnold, your assistant, offering the tour](docs/screenshots/pip.jpg)

### The fastest start: ⚡ Quick start

On your first visit, with nobody hired yet, Arnold offers **⚡ Quick start**:
three ready-made agents (a builder, a tester and a PR reviewer) sit down at
the first free desks and the stand-up opens. Press 🎤 and say what you want
done today — Claude outlines the plan, picks who does what (and says why),
and **Start the day** hands it out. From opening the office to agents at work
in two clicks and a sentence.

### Your own command line: `nou`

Everything that matters, from a terminal, against the office running on this
machine (the desktop app or `npm run dev`):

```bash
npm run build && npm link     # once: puts `nou` on your PATH
nou                           # what every agent is doing, and what's waiting for you
nou standup "Today I want dark mode shipped and the login bug fixed"
nou task "Update the README" --file notes.md   # someone offers to take it: Y / s / a
nou task "Fix the flaky test" --to Pixel
nou estimate "Add dark mode"  # how long and what it'll cost, cloud vs local; how close the last ones came
nou ask Bolt "How's it going?"                  # waits for the answer
nou watch                     # live: who's working, what's ready, what they say
nou watch Bolt                # one agent's terminal, live
nou review / nou review Grace # what's waiting, or one whole deck
nou approve Grace "Nice"      # or: nou back Grace "Cover the empty case too"
nou repo                      # your branch vs GitHub, agents' branches, pull requests
nou repo add ../api           # open another repo alongside (no restart); nou repo close api
nou hire builder --repo api   # hire into it (or: nou repo hire api, for every new hire)
nou task "Add the endpoint" --to Bolt --repo api   # Bolt moves to api for this one
nou move Bolt site            # or move an agent for good
nou pr "Dark mode"            # ship a goal as a pull request (--per agent: one per agent;
                              #   --agent Bolt: just Bolt's branch)
nou hire reviewer             # a ready-made agent at a free desk (nou roles lists them)
```

### Test it end to end

```bash
npm test             # unit tests
npm run e2e:ui       # the whole office in Chrome, simulated agents (31 checks)
npm run e2e:team     # a shared office: you and a teammate over the network, pods and borrowing (28 checks)
npm run e2e:real     # real Claude Code agents on a throwaway repo, from hire to
                     # opened pull requests (per goal and per agent) — audits, checks,
                     # a merge conflict (46 checks), against a stand-in for GitHub
npm run e2e:real -- --dry-run   # what it would do, and against which GitHub; starts nothing
```

`e2e:real` talks to a local stand-in for GitHub's API by default — no account,
nothing leaves your machine. To run it against a **real GitHub test
repository** instead, make a throwaway repo with at least one commit (a README
is enough) and a token that can push to it and open and close pull requests
and issues (fine-grained: *Contents*, *Pull requests* and *Issues*, read and
write, on that repo only), then:

```bash
E2E_GITHUB_REPO=you/domain-e2e-sandbox E2E_GITHUB_TOKEN=github_pat_… npm run e2e:real
```

It clones the repo, commits the toy library on top of its default branch
(locally — the default branch is never pushed), files two issues tagged with
the run's id, pushes the goal's branch and each agent's branch and opens their
pull requests, and follows their checks (a repo without CI counts as “no
checks”). Pass or fail, it then closes every pull request, deletes every branch
and closes every issue the run made (`E2E_GITHUB_KEEP=1` leaves them for you to
look at). The token stays in the environment: git reads it through a credential
helper, and it's never written to disk or the logs.

### Try it without any agents

```bash
DOMAIN_SIMULATE=1 npm run dev        # http://localhost:5173 — scripted workers that plan, present and talk back
```

### Other ways to run it

```bash
npm run dev           # browser, hot reload: server on :8787, client on http://localhost:5173
npm run electron:dev  # desktop app with hot reload
npm run build && npm start   # production server: http://localhost:8787
```

In the browser (or `npm run dev`), workers use the folder the server starts in,
or `DOMAIN_CWD=/path/to/project`.

## A look around

### New in v1.0

| | |
|---|---|
| ![Your phone: stand-up, focus, round up, reviews and lessons up top; alerts, chat, goals, workers, history, music and travel below](docs/screenshots/phone.jpg) **Your phone** (P) — everything, while you walk; autopilot on or off in one tap | ![Team chat with Task mode](docs/screenshots/team-chat.jpg) **Team chat** — message anyone, give a tracked **Task**, ask for an update; see what each is doing now |
| ![Handing out a task with an auditor, along the way](docs/screenshots/assign-audit.jpg) **Pair audits** — who audits it, when (or along the way), how many times it can go back; and a note, typed or said | ![The laptop's Team app](docs/screenshots/laptop-team.jpg) **The laptop's Team app** — message anyone, give a task, ask for an update |
| ![Letting a worker go, step two](docs/screenshots/send-home.jpg) **Send home, in two steps** — why (the team learns from it), then yes; bring them back any time | ![History](docs/screenshots/history.jpg) **History** — every hire, task, review, audit and ship, by day or by worker |
| ![A worker's terminal](docs/screenshots/terminal.jpg) **Terminals** — select to copy, drag to resize, or enlarge | ![The intern bay](docs/screenshots/intern-bay.jpg) **The intern bay** — eight more desks, for interns your workers bring in |
| ![Floor 2: the lounge](docs/screenshots/floor2-lounge.jpg) **Floor 2** — a lounge with a piano, darts and snacks, up the elevator | ![Floor 2: the library](docs/screenshots/floor2-library.jpg) **The library** — armchairs to work in, a shelf of tips |
| ![The pond and the fishing dock](docs/screenshots/pond.jpg) **The pond** — cast a line, press E when it bites | ![The running track](docs/screenshots/track.jpg) **The track** — run a lap through the arch; it's timed |

### Since the start

| | |
| :-: | :-: |
| ![The stand-up that opens every session](docs/screenshots/standup.jpg) **Stand-up** — goal, tone, intention, length | ![Handing out a task](docs/screenshots/assign-card.jpg) **Assignment card** — who, model, time budget, plan first, done means |
| ![A worker presenting in office hours](docs/screenshots/review.jpg) **Office hours** — checked by your tests, read aloud, approve or send back | ![Your laptop](docs/screenshots/laptop.jpg) **Your laptop** — browser, workers' terminals, the loop, decks, deploys |
| ![The game room](docs/screenshots/game-room.jpg) **Game room** — arcades, hoops, ping-pong, live work monitors | ![First person](docs/screenshots/first-person.jpg) **First person** — with your hand (and a coffee) |
| ![The campus outside](docs/screenshots/outside.jpg) **Outside** — plaza, fountain, pitch, street; real-time day and night | ![Team policy](docs/screenshots/team-policy.jpg) **Team policy** — models, leash, time budgets, branches and checks |
| ![The idea board](docs/screenshots/idea-board.jpg) **Idea board** — sketch it, then hand it to a worker or make it a goal | ![Drawing on a whiteboard in VR](docs/screenshots/vr-drawing.jpg) **VR** — draw on the whiteboards with your controller |

## Agents and models

Every worker is a real agent CLI running in a real terminal. You pick its
**model** when you hire it and per task; **Team policy** (🛠) lists the models
each agent offers.

| Agent | Command | Model flag | “Go ahead” leash |
| --- | --- | --- | --- |
| Claude Code | `claude` | `--model opus` / `sonnet` / `haiku` / a full name | `--permission-mode acceptEdits` |
| Codex | `codex` | `--model <name>` | `--sandbox workspace-write --ask-for-approval on-request` |
| Gemini CLI | `gemini` | `--model <name>` | `--approval-mode auto_edit` |
| OpenCode | `opencode` | `--model <provider>/<model>` (any provider it's set up for) | its own prompts |

Claude Code switches models mid-session (`/model`), keeping its context; the
other CLIs pick a model at launch, so a worker restarts on a new one.

### Local models

Yes. If **Ollama** (or **LM Studio**) is running, domain finds its models and
offers them in **Team policy** with one click (`ollama/<model>`,
`lmstudio/<model>`):

- **Codex** runs them through its open-source provider:
  `codex --oss --local-provider ollama --model <model>`.
- **Claude Code** runs Ollama's models through Ollama's Anthropic-compatible
  API (Ollama 0.14 or newer): just for that worker it's pointed at Ollama, and
  your own Claude login is left alone.
- **OpenCode** takes `ollama/<model>` once Ollama is set up as a provider in
  OpenCode's own config.

**Keep local workers' tasks small and simple** — a small model on a laptop is
slow, and loses the thread on anything big. A local Claude Code worker starts
**lean** (none of your own MCP tools, which crowd out a small model), and if
Ollama runs the model with too small a context window you're told how to raise
it: agents need 32K or more — Claude Code's own instructions alone are about
35K tokens, so on modest hardware **Codex** (whose prompt is much smaller) is
the better local agent.

Agents work through tool calls, so only models that support them are offered
(Ollama's `llama3`, for one, doesn't, so it's left out). A model that can't
“think”, like `llama3.1`, runs in Codex with reasoning off
(`-c model_reasoning_effort=none`), since Codex otherwise asks every model to
reason. Local models still vary a lot: pick one built for agentic coding, and
big enough for it. Hire one that won't fit in your computer's memory and you're
told straight away (in a toast and the Logs) rather than left watching it hang.

**Local models first.** They're free and private, so wherever you pick a model
— the hire card, a character, the assignment card — the ones on this computer
come first (🖥, *free, private*), even before you've added them to Team
policy. Hand a small task (a typo, the README, a 15-minute budget) to a cloud
model and the assignment card offers the local one instead; hand a big one (a
migration, a refactor across the app) to a local model and it warns you.
Autopilot does the same: small tasks go to workers on local models, big ones
wait for a cloud worker (unless the whole team is local).

**End to end.** Team policy shows each Ollama model's **context window**, and
when it's too small for an agent, **⤢ Make a 32K copy** creates one with
Ollama — same weights, nothing downloaded, just its own `num_ctx`
(`qwen3:8b` → `qwen3:8b-32k`). The first time a worker's hired on a local
model, a **speed check** measures how fast it writes on this computer
(tokens a second, in a toast and the Logs); a slow one (under 10/s) gets only
small tasks from autopilot.

## The office

- **Desk pods** on the west side. A green **+** marks a free desk: press **E**
  there to hire. Each worker's card says what it's doing, its task's clock and
  model, and its antenna light shows its status (yellow working, red needs you,
  purple presenting).
- **Boards** along the north wall: **Workers**, **Up next** (the line for your
  office) and **Goals**.
- **The lounge** round the TV, which counts down the focus session.
- **⭐ Your office**, the glass room in the south-east corner: a presentation
  screen, a podium, your desk and the review board. The line forms outside its
  door.

Through the doors in the south wall, a **hallway** leads to the rest of the
building:

- **☀️ The stand-up room**, where every visit starts. Its big screen shows the
  session's tone and intention, where the goal is in the loop, and the team.
  Workers with nothing to do **wait here for a task**, round the circle: walk
  up to one and press **E** to give it something new, or a task waiting on a
  goal.
- **☕ The kitchen**: grab a coffee (**E** at the machine) and you move 35%
  faster for 90 seconds — you'll see the cup in your hand.
- **🕹 The game room**, for while your workers grind: three arcade cabinets
  (*Snake*, *Bug Smash*, *Brick Breaker*, best scores kept), free throws at the
  hoop (time the power meter), ping-pong and beanbags, and a **🎱 pool
  table**: **E** racks up nine balls and opens it top-down — aim with the
  mouse (or ←/→), hold the button (or Space) for power, let go to shoot — and
  you clear the table in as few shots as you can (a scratch costs one; your
  best is kept). The balls on the table in the room follow along, and workers
  on a break come over and shoot a few racks of their own. Every cabinet
  keeps the **office's high scores** too: each finished game goes on a shared
  board (a person's best, top five), kept by the office and sent to everyone
  in it — guests in a shared office included. The cabinets show the board
  between their attract loops, the game's window lists it, and a new top
  score is shouted out to everyone. Two screens keep the
  workers and the goal in view, and the glowing pad by the door jumps you
  straight back to the work floor. The **jukebox** picks the office's music —
  *Lo-fi focus*, *Disco fever* (the mirror ball spins up and lights sweep the
  floor), *Synthwave drive* or *Ambient office* — composed live, nothing
  downloaded; there's a second jukebox by the lounge, and volume in Settings.
- **🛹 A skateboard**, anywhere: **B** hops on — twice as fast, and you glide.
- **🛎 The lobby**, whose sliding front doors open onto **the grounds**: a plaza
  and fountain, a five-a-side pitch with a ball you can dribble and kick, picnic
  tables, a street. Walk all the way round the building; the sky follows your
  real time of day. **Drive the cars** parked on the street: **E** to get in,
  **W/S** gas and brake, **A/D** steer, **Space** handbrake, **E** to get out —
  they stay wherever you park them.
- **Little things to use**: pop popcorn in the kitchen **microwave** (a minute's
  speed boost), catch the news on the lobby **radio**, click the **floor lamp**,
  squeeze the **teddy** on the couch, pet **Pixel the lobby cat** as she makes
  her rounds, and play **paper toss** at the bin in your office (farther is
  worth more). Grab a snack from the **vending machine** by the lounge, play a
  match of **air hockey** or a ball of **pinball** in the game room, take a
  **donut** at the stand-up (while they last), and play **fetch with Biscuit**,
  the dog on the lawn out front. Models from Kenney's CC0 kits — see
  `docs/ASSETS.md`.
- **Out back**, behind the building: a **running track** (run a lap through the
  start arch and it's timed, best kept), a **campfire** with logs to sit and
  work on (and marshmallows to roast), a **garden** that blooms as you water it
  and wilts a little each day you don't, and east of the building a **pond**
  with a dock — cast a line, and press **E** when the bobber dips.
- **🛗 Floor 2**, up the elevator (**E** at its doors, or **T**): a
  **library** (armchairs to work in, and a bookshelf of tips for running your
  team), a **lounge** (a sofa, a piano you play from your keyboard, darts, a
  vending machine) and a **gym** (treadmills, breathing mats for a calm minute,
  a telescope at the window). The city's outside the glass.
- **🧑‍💻 Floor 3, the team floor**, up the elevator too: four pods of four
  desks (A–D) for a bigger team. **More team floors open as the team grows**:
  once every desk on floor 3 is taken, **floor 4** opens (pods E–H) — you get a
  shout, and it's in the elevator's fast travel from then on — and when that
  fills, **floor 5** (pods I–L). Workers ride the elevator between floors like
  everywhere else, and a floor someone's working on stays open.

Press **T** anywhere to **fast travel** — the work floor, your office, any
room, outside, or straight to a worker that needs you. When a worker needs you
while you're away, you get a shout wherever you are. The **minimap** (bottom
right, **M** to hide) shows the rooms, the workers by status and the people
here; click it to travel. A floating **E** marks whatever you can use.

![Fast travel](docs/screenshots/fast-travel.jpg)

## The loop: goal → plan → build → review → ship

Fun is the wrapper; the point is that real work gets done. Every goal moves
through one loop, and there's always exactly one obvious next step.

1. **☀️ Stand-up** (**U**, and automatically when you arrive): pick today's goal
   or set a new one — **🛠 build** something or **📚 research** a question —
   **set the tone** (🚀 Ship it, 🧘 Deep focus, 🧪 Explore, 🐛 Bug hunt), say what
   would make the session a win, and pick a length. It starts a focus session;
   the tone tints the office light.
2. **🧠 Plan**: no tasks yet? *Plan with a worker* briefs one to break the goal
   into a checklist; the tasks appear on their own. Or type them yourself.
   With more than one worker free, the plan goes to a **🤝 team huddle** first
   (see below).
3. **⌨️ Build / 🔎 Research**: hand out tasks; each worker is briefed in its own
   terminal with the goal, the task, its time budget and what "done" means.
4. **🎤 Review**: round them up (**R**), hold office hours (**O**), approve or
   send back changes. Approved tasks check themselves off.
5. **🚀 Ship**: when every task is done — after a **🎬 demo** of what was built
   (see below) —
   - *build goals* run your configured deploy command (shown before it runs,
     output streamed to your laptop's Deploy app). If it fails, one click hands
     the log to a worker to fix. With no deploy command, a worker opens a PR,
     or you mark it shipped yourself.
   - *research goals* end in a **slide deck** the workers write as they go.
     Present it, or download it as **.pptx** or Markdown.

Manual overrides are always there — tick a task, re-plan, mark shipped — so
nothing gets stuck. Each goal's files live in `.domain/goals/<id>/`
(`plan.md`, `deck.md`, `shipped.md`, `deploy.log`, `huddle.md`, `demo.png`).

### 🤝 The team huddle, and 🎬 the demo

- **A huddle at the start of a goal.** When a worker's draft plan lands and
  others are free (the goal's group, or anyone not on a task — up to four),
  they don't just get handed tasks: the team gathers round the stand-up circle
  and everyone weighs in. Each teammate reads the draft and writes a short note
  — a concern or two, a suggestion, and the task they'd take — shown in the
  **Team huddle** window (🤝 *Watch the huddle* in the loop) and as speech
  bubbles in the office. Then the planner revises the plan from the notes, and
  the revised tasks go on the goal; a task someone asked for is saved for them.
  It's bounded: one short brief per teammate, three minutes to gather and three
  to revise — whatever isn't in by then is left out, and if no revision comes
  the draft stands. **⏭ Skip** sends the plan out as it is, any time.
  `"huddle": false` in `domain.config.json` (or `DOMAIN_HUDDLE=0`) turns it off.
- **A demo at the end.** When every task of a build goal is approved, the
  office captures what was built and offers it to everyone in the office
  (🎬 *Watch the demo*, also in the loop's Ship step): a **screenshot** of the
  running app, taken by a headless Chrome or Edge, or — for anything without a
  page — a **captured terminal run** and its output. What it captures, first
  that applies: `"demo"` in `domain.config.json` (a URL to screenshot, or a
  command to run), your `"preview"` URL, a dev server running on this machine,
  then your `"check"` command. **↻ Capture again** after a fix. Set
  `DOMAIN_BROWSER` if your browser isn't where it usually installs.

### 🛠 Running your team

- **Hiring**: pick the agent, the **model** it starts on, and its **leash** —
  *ask before edits*, or *go ahead* (see [Agents and models](#agents-and-models)).
- **Handing out a task** opens the **assignment card**: who does it, which
  **model**, a **time budget** (15–90 min, or none) and what happens when it runs
  out (*nudge it to wrap up*, or *stop and present*), **plan first** (it presents
  a plan in your office; you approve it, then it builds), and the task's own
  **definition of done**.
- **⏳ Estimates for every job**: the card opens with how long the task will
  likely take and what it'll cost on the model you picked
  (`~25 min (15–40) · ≈ $1.70`), or that it's free on a local one, and
  it changes as you change the worker, model, plan first, audit, notes or
  files. If the estimate runs past the time budget, the card says so. The
  first guess comes from the task's size (its words and notes, read the same
  way as for the local-model hint, then plan first and an audit). After that
  it's scaled by how long similar tasks really took this team: tasks with
  shared words in the title, the same size or the same model count most.
  Every finished task records the time from handing it out to its last
  presentation (time waiting for your review isn't counted) next to its
  estimate. The last 200 are kept with your progress, so the estimates get
  better. The Goals window, the laptop's **Loop** app and the phone's
  **Goals** show it as well: before a task goes out (on cloud, or free on a
  local model), while it's being done, and what it took against the estimate
  once it's done. Each goal also shows the work left on it and how far off
  the estimates have been lately. Costs are rough per-hour figures for a
  coding agent on that model (Opus more than Sonnet, Sonnet more than Haiku),
  not a bill.
- **Team policy** (🛠 in the Goals window, the hire menu or the card): the
  defaults everything starts from, shared by everyone in the office and saved
  with your progress.

### 🌿 Own branches and a check before review

- **Own branch per worker** (on by default in a git repo): each hire works in
  its own git worktree under `.domain/worktrees/`, on its own branch
  (`domain/<agent>-<desk>-…`), so parallel workers never touch the same files.
  `.domain/` is kept out of `git status` through `.git/info/exclude`.
- **Trusting the folders, once**: agents like Claude Code ask whether to trust
  a folder they haven't seen. The first time, Arnold asks you instead — **✅ Trust
  this project** — and from then on every worker's prompt in that project is
  answered for you (the office reads which option is highlighted and picks
  *yes*; it never guesses). Until you answer, the desk shows *needs you* and
  briefs wait. Your choice is kept per project in `~/.domain/prefs.json`.
- **Your dependencies come along**: a worktree only has what git tracks, so each
  one links to your checkout's installed `node_modules` (and `.venv`) wherever
  git ignores them — the check runs with your project's own tools, and the links
  are taken out before a folder is removed (your installs are never touched).
- **Commits are yours**: the merge when you approve, and anything the office
  commits for a worker, use your git name and email — so GitHub (and anything
  that checks authors, like Vercel) sees your account.
- **Approving finished work merges it**: whatever the worker left uncommitted
  is committed on its branch, then merged into the branch you're on. If it
  conflicts, nothing lands — the work goes back to the worker to merge your
  branch in and resolve. If your checkout has uncommitted changes, the merge
  waits and you're told. (Or set the policy to leave work on its branch.)
- **Before each new task** the worker's branch catches up with yours.
- **A worker that leaves** has its folder removed; a branch with work that never
  reached yours is kept.
- **A check before review**: set `"check"` in `domain.config.json` (or
  `DOMAIN_CHECK_CMD`). It runs in the worker's folder when it presents finished
  work. If it fails, the work goes
  straight back with the output (up to 2 tries) so you only review work that
  passes; the review shows ✅ passed, or ❌ failed with the log and *Approve anyway*.

Nothing is pushed while workers work: every git step is local until you ship
(a pull request pushes `domain/<goal>`).

### 💻 Your laptop (L)

A laptop in your hands, anywhere: **💬 Team** to message anyone, give someone
a task or ask for an update; a **Browser** showing the app your workers
are building (your preview URL, or any local dev server it finds), **Workers**
with each one's live terminal, the **Loop** for your goal, **Decks** for
research goals, and the **Deploy** console.

The browser has tabs: **＋** for a new one (it lists your running dev
servers), **×** (or a middle-click) to close one; each keeps its own page and
history, and they're remembered.

Press **L** by a couch, a table, an armchair or the campfire and you sit down
and set it up there. It stays where you left it: walk back and press **E** to
pick up where you were.

### 📱 Your phone (P)

The top bar keeps the everyday few — Goals, Phone, Laptop, Office, Chat.
Everything else is on the phone, in your pocket, while you keep walking: a
row for **Stand-up**, **Focus**, **Round up** and **Reviews**, then **Alerts** (what needs you
now, with a button to deal with it), **Chat** (message everyone, or open any
worker's channel), **Goals** with their deadlines, **Reviews** (the line, office
hours, round up), **Workers** (chat, terminal, or go there), **History**,
**Music** and **Travel**. The button in the corner buzzes with a count when
something needs you.

### 🔔 Reminders and deadlines

Give a goal a **due date** (in Goals, or when you set it at stand-up) and you're
reminded an hour out, fifteen minutes out and when it slips. You also hear —
with a chime, in Alerts and from Arnold — when a worker has been **waiting on you**
for a minute and a half, when someone's been **waiting to present** for five
minutes, when a task's **time budget** is about to run out, when the **session**
is ending, and when a worker is **free** while tasks sit unassigned. Urgent ones
come back every few minutes until they're dealt with.

### 🗣 Say it

Wherever you hand out work — the assignment card's **Anything else they
should know?**, the chat, the laptop's Team app, the phone, a goal's **Add a
task** — press **🎤** and say it instead of typing. In the desktop app it starts
your computer's own dictation in that box for you: on **Windows**, voice typing
(the office presses **Win + H**; press 🎤 again to stop); on **macOS**, the
Mac's dictation (the same as **Edit → Start Dictation…**; it stops with **Fn**,
**Done** or a pause). If it can't — dictation turned off in System Settings →
Keyboard, or a locked-down PC — the box says so and how to start it by hand
(**Win + H**, or **Fn** twice). In a browser, it uses the browser's.

### 🗣 Voices

Workers read their presentations aloud in your computer's voices — or, with an
**ElevenLabs** API key, in lifelike ElevenLabs voices. **Office → 🗣 Voices**:
paste the key, hear each voice, and choose whether workers without a voice of
their own use ElevenLabs; give a character its own in **Your team**. The key
stays on your computer (`~/.domain/elevenlabs.json`, or `ELEVENLABS_API_KEY`)
— never in a project or the browser — and only the host can set it. Speech is
cached, so replaying a slide doesn't spend your credits again; if ElevenLabs
fails, your computer's voice says it instead.

### 🔊 Sound

Besides the music, the office sounds like one: the air handling's hum and a
far-off murmur indoors (a phone, the printer now and then), wind and daytime
birds outside, the keyboards of busy workers near you, doors, the elevator,
and a car's engine when you drive. **Settings → Sound** has the effects and
the background, each with its own volume. It goes quiet while the window is
hidden.

### 🔐 Permission levels

How much a worker may do without asking you — set per hire, per character,
or as the team default. Each agent gets its own CLI's flags, and the worker is
told its level in every task brief:

| | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| 🙋 **Asks first** | its prompts | read-only sandbox, asks | its prompts |
| ✏️ **Edits OK** | `acceptEdits` | workspace-write, asks for commands | `auto_edit` |
| 🛡 **Safe actions auto** | `auto` (its own reviewer) | `--approve-for-me` | `auto_edit` |
| 🚀 **Never asks** | `bypassPermissions` | workspace-write, never asks (still sandboxed to its folder) | `yolo` |

When a worker does stop to ask, its desk says **needs you**, you're
reminded, and anything you send it waits until you've answered — so a
message can never pick one of the prompt's options by accident.

### 🔍 Pair workers: one builds, one audits

On the assignment card, pick who **audits** it, **when** — when it's done, or
**along the way** (the builder stops at checkpoints, the auditor checks each
one, and they go back and forth before it carries on) — and how many times
at most it can be sent back (1–5, three by default). When the builder says it's done (and the check
passes), it goes to the auditor first — its changes are written into the
auditor's own folder — and the auditor approves it or lists what's wrong. Issues
go back to the builder, and back and forth until it's approved or the rounds
run out (or the audit takes over 25 minutes). Then it comes to you, once, with
the audit's verdict and everything it found along the way.

### 🤖 Autopilot: the office runs itself

Turn it on in **Team policy** (or with one tap on the phone) and the office
keeps itself going:

- Goals with no tasks get **planned** by a free worker.
- Free workers pick up the **next tasks** — deadlines first, a group's goal
  only by its members — each with a teammate **auditing** it.
- Work whose **checks passed and whose auditor approved it** is approved
  without you (you can turn that off).
- When every task in a goal is done, its **lead pulls it together** — makes
  it work as a whole, fixes the gaps — and presents *that* to you: the one
  thing you need to see.
- The **end-of-day sync** runs at its time (17:30 by default).

Questions, plans, and anything an audit couldn't settle still come to you,
with reminders.

### 👋 Letting someone go, and bringing them back

**Send home** (in a worker's terminal) takes two steps: first *why* — optional,
but the reason goes into the team's lessons so the next one doesn't make the
same mistake (or give them different work instead) — then a clear yes. They're
kept among your **former workers**: hire at any free desk and **bring them
back**, same agent, model, permissions and character.

### ☕ Waiting, and breaks

A worker with nothing to do walks to the **stand-up room** and waits round the
circle for a task (its card says so) — press **E** by it to hand it one. Now
and then it takes a short break round the lounge or at the game room's pool
table (where it shoots while nobody else is playing), and it walks back to its
desk the moment there's work. It's only them walking about: no agent is doing
anything, so it costs nothing.

### 🎓 Interns

A worker whose task splits into independent pieces can bring in up to three
interns. They're hired at the **intern bay** (eight more desks on the north of
the work floor), each gets a piece, the worker audits their work before it
goes anywhere, and they go home after ten idle minutes. Their desks say whose
interns they are, and you can open their chat and terminal like anyone's.
(On or off in Team policy.)

### 📚 Lessons, and the end-of-day sync

The team learns from **whatever you tell it**. Work you send back with notes,
what an audit finds, and anything you say in chat, to #team or at a desk
that's a rule ("from now on…", "never push to main"), a correction ("that's
wrong", "this needs to change") or praise ("perfect, love it") goes
straight into the team's **lessons** (`.domain/LESSONS.md`, in every worker's
folder) — and every brief says to read them first, so the whole team learns
from it at once. At the **end of the day** each worker writes up what it
learned (its mistakes, what you sent back, what worked), and one of them
merges it all into a short list — duplicates merged, stale ones dropped. Every
step has a time limit, and if the merge never comes nothing's lost. See them
in **Lessons** (Office menu, or the phone) — where you can also **teach** the
team a lesson yourself, or drop one that was noted by mistake.

### 🎓 Skills

Each agent's skills (the `SKILL.md` folders its CLI loads — yours and the
project's) are shown when you hire it and on each worker. They're all on by
default; untick any in a character's editor and it can't use them (Claude Code
has them blocked for its session; the others are told).

### 👥 Groups

In Goals, tick a few workers under **Group** and **give it to them**: if the
goal has no tasks yet, the first one plans it; then a task goes to each one
who's free, and the next one as each finishes.

### 📜 History

Everything that happens is kept (in `.domain/history.json`): hires, tasks
handed out, reports, approvals and changes, audits, groups, deadlines, ships.
Open **History** from the Office menu or the phone — by day, everything or one
worker — and each worker's **Work** tab in the team chat shows what it's done
before.

## Run the office (🏢)

The **🏢 Office** button holds everything about running the office itself.

![The Office menu](docs/screenshots/office-menu.jpg)

### Projects and GitHub

Which project your workers are on, the ones you've opened before, and
GitHub — without pasting tokens.

- **Recent projects**: switch in a click (the app restarts on it).
- **Open a folder**: the native folder picker, or paste a path.
- **Start from GitHub**: **Sign in with GitHub** uses git's own sign-in (Git
  Credential Manager opens the browser once; domain never stores your token),
  then pick one of your repos or paste `owner/repo` / a URL. It's cloned into
  `Documents/domain/projects/`, with the clone's progress shown live, and the
  office opens on it.
- **Ship as a pull request**: on a GitHub project, a finished goal's next step
  is **Open a pull request** — the work is pushed to `domain/<goal>` and a PR
  opens against the default branch, with the goal, its tasks and the session's
  intention. Its checks are followed and shown on the goal.
- **A pull request per agent**: or open one per agent instead — each agent's
  own branch (`domain/<agent>-<desk>-…`) is pushed as it is, and its PR lists
  just the tasks that agent did, so each can be reviewed and merged on its own.
  Pick it for the team in **Team policy → Branches & checks** (*one pull
  request per goal / per agent*), or once from the goal's ship step (*One pull
  request per agent instead*), or with `nou pr --per agent` (`--agent NAME` for
  one agent's). Agents with nothing GitHub doesn't already have are skipped,
  and so is an agent whose PR is still open. Every PR's checks are followed
  and shown on the goal.
- **GitHub issues → tasks**: import open issues into a goal from the Goals window.
- **Several repos at once**: **Add** (next to Open, on a recent project, a
  path, or a clone with *Open the clone alongside*) opens another repo
  alongside the project — no restart. Each worker works in one repo: the one
  it was hired into (**Hire here** picks where new hires go; the project
  until you pick another) or moved to (each worker has a repo picker in the
  Projects window; it restarts there on a branch of its own). A task can name
  another repo in the assignment card (**📂 Repo**) or with
  `nou task … --repo NAME`: the worker moves there first. Each repo has its
  own worktrees (`~/.domain/worktrees/<repo>-<id>`), its own check (its own
  `domain.config.json`), and approved work merges into *that* repo's branch.
  A goal's pull request goes to the repo its tasks were done in, and its
  checks are followed there. The Repo view and `nou repo` show every open
  repo. The list is kept in `.domain/repos.json`; an office that never opens
  another repo works exactly as before.

![Projects and GitHub](docs/screenshots/projects.jpg)

### Your team

Workers with names, faces and personalities you set once and hire again and
again. A **character** keeps its agent, model and leash, a **persona** (standing
instructions added to every task it gets — e.g. *“Write or update tests first,
keep commits small”*), a **voice** for its presentations, its **look** (color,
face, hat, accessory) and its **MCP tools**. Make one from the hire window
(**＋ New character**) or Office → Your team; its name shows over its desk, in
the panels and when it presents. **Quick hire** still gives you a plain worker.

| | |
| :-: | :-: |
| ![Hiring from your team](docs/screenshots/your-team.jpg) | ![The character editor](docs/screenshots/character-editor.jpg) |

### Agent CLIs

Which version of each coding agent you have, and the newest out. An
out-of-date CLI can stop working (Codex 0.157 hung at "model: loading" until it
was updated), so when one's out Arnold offers it, and **Office → Agent CLIs**
has an **Update** button. The update waits until none of that agent's workers
is busy, pauses the free ones (on Windows a running CLI holds its own files),
installs, and starts them again in their last conversation. The output is in
Logs.

- Installed with **npm**: updated with `npm install -g <package>@<version>`.
  If an update breaks something, **📌 Keep** a version: updates install that
  one until you unpin it.
- Installed with its **own installer**: Claude Code updates itself
  (`claude update`); for the others, it says a new one's out and you update
  it the way you installed it.

**A stuck worker** says why, in its CLI's own words — signed out, can't reach
its service, an API error (overloaded, rate limit), or it needs an update —
and goes red ("needs you"). Its terminal shows what it said with the fix one
click away: **🔑 Sign in** (Claude Code's `/login`, Gemini's `/auth`; for Codex
and OpenCode, the command to run), **⬆ Update**, or **🔄 Restart** — its CLI
starts again, back in its last conversation. Restart is always in the
terminal's footer too. A CLI that says it's retrying isn't flagged.

### MCP tools

MCP servers are tools your workers can use — read files, browse the web, work
with GitHub, drive a browser. Add one once (presets: Filesystem, Fetch,
Playwright, GitHub, Context7, Memory — or any command or URL), then give it to
**everyone** or to the characters you pick. Each worker gets them for its own
session only — your agents' own settings are never changed:

| Agent | How it's given the servers |
| --- | --- |
| Claude Code | `--mcp-config .domain/mcp/<desk>/claude.json` |
| Codex | a profile file `~/.codex/domain-…-<desk>.config.toml` and `-p` |
| Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` |
| OpenCode | `OPENCODE_CONFIG` |

The window also lists the servers your agents **already load** from their own
configs, and a health check shows each one's tools, *needs sign-in*, or the
error. Secret values (tokens, headers) never leave the server or show in logs.

![MCP tools](docs/screenshots/mcp.jpg)

### Invite people (local multiplayer)

Work together on the same Wi-Fi. **Invite people** opens your office to your
local network with a **6-digit passcode** and shows the address to open (e.g.
`http://192.168.1.23:8788`); people can also find it under **Join a nearby
office** in their own domain app. Choose what guests can do:

- **👀 Visitors** walk around, watch the workers and their screens, and see the
  goals. They can't change anything.
- **🤝 Teammates** also hire workers, hand out tasks, review and ship — and they
  can type into workers' terminals, **which run on your computer**, so only
  invite people you trust.

Some things stay with you whatever the role: your GitHub sign-in and repos,
switching projects, MCP tools, and sharing itself. Wrong codes are rate-limited,
guests never see the code, and **Stop sharing** disconnects everyone.

**Pods for people.** Everyone in the office gets a **pod** on the team floor
(floor 3) — a cluster of four desks for them and their agents, with their name
hung over it (*⭐ Your pod* on yours; dimmed while they're away). You keep the
same pod each time you come back (it's remembered by name in
`.domain/pods.json`); a newcomer gets a free pod, or the pod of someone who
isn't here. While someone's in, the desks in their pod are theirs to hire at;
everywhere downstairs is open to all.

**Borrowing an agent.** Agents you hire are yours to direct; a teammate can
message them, and can also **ask to borrow** one — **🤝 Ask to borrow** on its
tile in the agent monitor (**K**). You get the question from Arnold, like an
agent's *"I'll take it"*: **✅ Lend** or **🙅 Not now**. On yes it works for
them — their tasks, their keys, their reviews — and its card says
*🤝 Working for Ana (Jorge's)*. It comes back when they **↩ Give back**, when
you **↩ Call back**, when the task they gave it is done, when it leaves its
desk, or when either of you leaves the office. An ask nobody answers lapses
after two minutes.

> First time you share, Windows asks to allow domain on networks — allow
> **Private networks** (or add an inbound rule for the port in Windows Defender
> Firewall). Discovery uses UDP 8790; some networks block it, but typing the
> address always works. Guest Wi-Fi with "client isolation" blocks joining.

| | |
| :-: | :-: |
| ![Invite people](docs/screenshots/invite.jpg) | ![Joining with the passcode](docs/screenshots/join.jpg) |

### Logs

Every git, GitHub, MCP, check and deploy step the office runs for you — with
its icon, the command, its output and any link — in **Office → Logs**, and
inline wherever it happened (a clone, a ship, an MCP check).

![Logs](docs/screenshots/logs.jpg)

## Make work a game

- **🎯 Goals** (**G**): set a goal and break it into tasks; finish every task and
  the goal ships 🚀. The **Goals board** on the wall tracks the one you're on.
- **⏱ Focus sessions** (**F**, or the stand-up): a 25, 50 or 90-minute sprint for
  the whole office. When it runs out, everyone here earns XP and keeps their
  daily 🔥 streak; you get a summary of what got done.
- **XP and levels**: hiring, planning, assigning, reviewing and above all
  finishing tasks (+50), shipping (+150), goals (+250) and sessions (+4/min).
  Climb from *Intern* to *Founder*. Click your card for stats, **achievements**
  and the office **leaderboard**.
- **Juice**: the gong rings when work ships, confetti for level-ups and shipped
  goals, footsteps, an activity feed of everyone's progress.

Progress is saved to `.domain/progress.json` in your project. Scores follow
your name.

## Reviews (office hours)

1. **Round up** (📣, or **R**): call everyone, or tick the ones you want. Each
   stops to prepare a short progress report and lines up outside your office.
2. **Office hours** (🎤, or **O**, or **E** at your desk): the first worker
   whose report is ready (and has passed your check) presents: a slide deck, read
   aloud in its own voice and mirrored on the big screen. Flip slides with ← →.
3. **Talk to it.** Hit **🎤 Talk** and speak (or type): your words go into that
   worker's CLI, and its answer comes back as speech.
4. **The review board.** Draw on it; the sketch goes to the worker with your
   feedback.
5. **Decide.** You sit in your chair facing the screen; in Settings →
   *Office hours* choose a **window** (slides, review board and conversation
   side by side) or the **projector** (the slides on the big screen, read
   aloud, with a slim bar to ask, approve or send changes). **Approve** (merges its branch, and the worker stops and waits
   for its next task), **Send changes**, or **Later**. Approving a plan — or a
   decision a worker was blocked on — lets it carry on.

Voice uses the browser's free Web Speech API — no keys, no costs. Dictation
needs Chrome or Edge (in the desktop app it depends on the speech service being
reachable — if it isn't, open http://127.0.0.1:8787 in Chrome, or type).

## Team chat (C)

Like Slack, with your workers: **#team** reaches everyone at once, and each
worker has its own channel with its whole history (a character's history
follows it from hire to hire). Your message reaches the worker as an
instruction in its terminal; it answers in the channel, and answers pop up as
toasts wherever you are. Each channel also shows:

- **🧠 Now** — what's on its screen right now, with ⏎ / Esc / 1 / 2 keys for
  its prompts.
- **📜 Work** — the task it's on, the commits on its branch and the files it
  has changed.
- **🎯 Task** mode in the message box makes what you write a real task for
  that worker: tracked (on the session's goal, or a "Quick tasks" goal),
  checked, and presented to you when it's done.
- **⌨️ Terminal** mode types straight into its CLI (commands, answers), and
  **🖥 Terminal** opens the terminal itself.
- **📍 Ask for an update** — from one worker, or everyone in #team.

A message to a worker that's asking you something (a permission prompt) waits
until you've answered it, so it can never pick one of the prompt's options.
The same is on your laptop (**💬 Team**) and your phone (**Chat**). Clicking a
worker in the Workers list opens its channel.

## Closing up, and the gong

Close the app and every worker's terminal is shut down cleanly — but the
office remembers its team: who sat where, on which model, as which
character, with its own branch and folder. Next time they're **asleep 💤** at
their desks. **Ring the gong** by the elevator (E) and everyone wakes up back
in their last conversation (Claude Code `--continue`, Codex `resume --last`,
Gemini `--resume latest`, OpenCode `--continue`) and is told to carry on; or
press E at one desk to wake just that worker. The gong also rings by itself
when work ships.

## Idea boards

The whiteboard on wheels on the work floor and the one in the stand-up room are
**idea boards**. Walk up and press **E** (or 🏢 Office → **Idea board**):

- **Sketch it** with the markers, give it a name and a few notes (or dictate
  them with 🎤). Lines in the notes that start with `-` become tasks.
- **📌 Pin it** — it goes up on both boards as a sticky note with your sketch,
  for everyone in the office to see.
- **🤝 Hand it over** to a worker — it becomes a task on the goal in focus (or a
  new goal), and the worker is briefed with your notes and the path to the
  sketch (saved in `.domain/ideas/`) so it can open it and look.
- **🎯 Make it a goal** — its first line is the why, its `-` lines the tasks;
  when those tasks go out, their briefs carry the idea and sketch too.

Pinned ideas are listed under the board, coloured by where they went (on the
board, with a worker, a goal). Visitors on your network can read them; teammates
can pin and hand off too.

![An idea handed to a worker, on the board](docs/screenshots/idea-board-floor.jpg)

## VR

With a headset, **🥽 VR** appears in the dock. Click it and you're standing in
the office:

| Controller | Does |
| --- | --- |
| Left stick | Walk the way you're looking |
| Right stick | Snap-turn 30° |
| Trigger | Press what the laser points at — a panel's button, or **draw on an idea board** · pointed at nothing, it's **E** |
| A / X | **E**: use what's in front of you |
| B / Y | The menu: travel, office hours, round everyone up, leave VR |
| Hold a grip | **Talk** — to a worker at its desk (typed into its terminal), in a review (your question or the changes you want), or at an idea board (its name) |

Windows become floating panels in VR: a worker's status with ⏎/Esc keys and
"call it in to present"; hiring at an empty desk; **office hours** with the
slides on the big screen, read aloud, and Back / Next / Ask / Approve / Send
changes / Later; and the idea board, where you draw with your laser and pin it
or hand it to a worker. Anything else that would open a window tells you it's
waiting on your monitor. Toasts float in front of you.

![Office hours in VR](docs/screenshots/vr-review.jpg)

**What you need.** VR uses WebXR, so open the office in **Chrome or Edge** on
the computer running it — http://127.0.0.1:8787 — with a PC headset connected
(SteamVR, Windows Mixed Reality, or a Quest over Link / Air Link). The desktop
app usually won't offer it (Electron's WebXR support isn't official) — use the
browser. A Quest's own
browser over Wi-Fi isn't supported yet: WebXR needs HTTPS off localhost.

**No headset?** Run `npm run dev` and open http://localhost:5173/?vr — it
emulates a Quest 3 (dev builds only) so you can try VR in the browser.

## How agents take part

Real agents follow a small file contract, written to `.domain/BRIEF.md` in your
project when the office starts. Each worker's terminal has these set:

| Variable             | What it's for                                              |
| -------------------- | ---------------------------------------------------------- |
| `DOMAIN_DESK`        | The worker's desk id.                                      |
| `DOMAIN_REPORT_FILE` | Write a report here (JSON) to present it.                  |
| `DOMAIN_REPLY_FILE`  | Write `{"say": "...", "at": <ms>}` here to answer out loud. |

A report (`status` is `ready`, `blocked`, or `plan` for a plan to approve):

```json
{
  "status": "ready",
  "title": "Login page is in",
  "summary": "One paragraph, read aloud as the worker presents.",
  "slides": ["Added the form and validation", "Wired it to the session API", "Tests pass"],
  "question": "Only when blocked: the decision it needs.",
  "preview": { "url": "http://localhost:3000" },
  "at": 1700000000000
}
```

Tasks, round-ups, what you say in a review and your decisions all arrive in the
worker's terminal as its next instruction, so any agent CLI that reads its
prompt can take part. If an agent's CLI isn't installed, its desk gets a real
local shell instead.

## Configuration

`domain.config.json` in your project (every key optional):

```json
{
  "preview": "http://localhost:5173",
  "deploy": "npm run deploy",
  "check": "npm test",
  "demo": "http://localhost:5173",
  "huddle": true,
  "team": {
    "models": { "claude": ["opus", "sonnet", "haiku"], "codex": ["ollama/qwen3-coder"] },
    "defaultModel": { "claude": "sonnet" },
    "leash": "ask",
    "minutes": 30,
    "onTimeUp": "wrapup",
    "planFirst": false,
    "done": ["It does what the task says", "Tests pass", "Nothing unrelated changed"],
    "isolate": true,
    "merge": "auto",
    "gate": "fix"
  }
}
```

| Key | Does |
| --- | --- |
| `preview` | The URL your laptop's browser opens. |
| `deploy` | The command **Ship it** runs (only ever this command). |
| `check` | The command run on finished work before you review it. |
| `demo` | What the demo at the end of a goal shows: a URL to screenshot, or a command whose output to capture (default: `preview`, a running dev server, then `check`). |
| `huddle` | `false` turns off the team huddle on a goal's plan. |
| `team` | Starting defaults for Team policy (it's edited in game after that). |

Environment variables:

| Variable | Does |
| --- | --- |
| `DOMAIN_CWD` | The project folder workers work in (default: where you start it). |
| `DOMAIN_SIMULATE` | `1` runs scripted workers instead of real terminals. |
| `DOMAIN_PREVIEW_URL`, `DOMAIN_DEPLOY_CMD`, `DOMAIN_CHECK_CMD` | Override the config file. |
| `DOMAIN_DEMO`, `DOMAIN_HUDDLE` | Override `demo`, and turn the huddle off (`0`). |
| `DOMAIN_BROWSER` | The Chrome, Edge or Chromium that takes demo screenshots (found on its own otherwise). |
| `DOMAIN_PROJECTS_DIR` | Where GitHub clones go (default `Documents/domain/projects`). |
| `DOMAIN_PREFS` | Where recent projects are kept (default `~/.domain/prefs.json`). |
| `DOMAIN_GITHUB_API` | The GitHub API base (for GitHub Enterprise). |
| `OLLAMA_HOST`, `LMSTUDIO_URL` | Where to look for local models. |
| `PORT`, `HOST` | Server port (`8787`) and bind address (`127.0.0.1`). |

> **Security:** anyone who can reach the server can run commands on the host as
> you — that's what an agent office is. It listens on `127.0.0.1` only, and the
> WebSocket refuses pages served from anywhere else (and DNS-rebinding hosts),
> so other websites open in your browser can't drive it. Don't expose it with
> `HOST=0.0.0.0` on a network you don't trust.

## Controls

| Key / action  | Does |
| ------------- | --- |
| Click         | Capture the mouse to play: it hides and steers the view; click again to use things |
| `Tab` · `Ctrl`| Free the mouse for the menus |
| `W A S D`     | Walk where you're looking · `Shift` run · `Space` jump |
| Scroll        | Zoom — all the way in for first person, out again for third |
| `V`           | Switch first / third person (also in Settings) |
| `B`           | Skateboard on / off — twice as fast, and you glide |
| `C`           | Team chat |
| `Q`           | Put your coffee down |
| Driving       | `E` by a car gets in · `W`/`S` gas and brake (or reverse) · `A`/`D` steer · `Space` handbrake · `E` gets out |
| `E`           | Use whatever the floating **E** marks: hire, a waiting worker (give it a task), a car, terminal, office hours, the idea boards, the jukeboxes, coffee, arcades, the pool table, hoops, the ball, the elevator, your laptop where you left it, darts, the piano, the vending machine, treadmills, the breathing mats, the bookshelf, the telescope, fishing, the garden, the campfire, the microwave, the radio, the lamp, the teddy, the cat, paper toss, the office vending machine, air hockey, pinball, the donuts, Biscuit the dog |
| `T`           | Fast travel |
| `U`           | Stand-up |
| `G`           | Goals |
| `L`           | Your laptop — near a seat, sit down and work there |
| `P`           | Your phone |
| `F`           | Start a focus session |
| `R`           | Round up workers for a review |
| `O`           | Office hours: the next one in line presents |
| `M`           | Show or hide the minimap |
| `← →`         | Flip slides in a presentation |
| `H`           | Controls |
| Terminal      | **Select to copy** — it's on your clipboard at once · drag the corner to resize, or **⤢ Enlarge** · **📋 Copy** all of it |
| `Esc`         | Close a window · with nothing open, **Settings**: view, walk speed, sprint, mouse sensitivity, field of view, **graphics** (High / Balanced / Fast — it lowers itself if the game runs slow), hand, head bob, minimap, day and night, sound — effects and background, each with a volume (`Ctrl+[` sends Esc to a terminal) |

## Layout

```
src/
  shared/
    protocol.ts          typed client/server messages + office state
    layout.ts            the floor plan: building, rooms, grounds, floor 2, work spots, routes, camera walls
    history.ts           what the office remembers happened
    darts.ts             where a dart scores
    pool.ts              the pool table's physics, rack and the workers' shot picker
    arcade.ts            the office's arcade high-score boards
    progress.ts          goals, sessions, XP, levels, achievements, the loop's stages
    policy.ts            team policy and task briefs (models, leash, time, done)
  server/
    index.ts             static server + WebSocket (local-only), the loop's wiring
    office.ts            desks, workers, the line, reviews, task briefs
    workerSession.ts     worker backends + agent launch commands (model, leash)
    ptyWorker.ts         real local terminal (node-pty) running the agent CLI
    worker.ts            simulated worker
    workspace.ts         a git worktree and branch per worker; merges
    projects.ts          projects, cloning, GitHub sign-in, PRs, issues (with github.ts, prefs.ts)
    repos.ts             the repos open alongside the project (a repo per agent)
    team.ts              your team's characters
    mcp.ts               MCP: scan agents' configs, health checks, per-worker servers
    lan.ts               local multiplayer: the passcode listener, discovery
    pods.ts              pods for people on the team floor, and borrowing agents
    ideas.ts             the idea boards: pinned ideas, sketches, hand-offs
    arcade.ts            the arcade's high scores, saved to .domain/arcade.json and sent to everyone
    agents.ts            which agent CLIs are installed; installing a missing one
    oplog.ts             the operations log
    permissions.ts       what guests may do
    checks.ts            the check run before review
    loop.ts              config, plans, decks, deploys, local model discovery
    reports.ts           watches report and reply files; writes BRIEF.md
    progress.ts          keeps score; saved to .domain/
    history.ts           the office's history, saved to .domain/history.json
    audits.ts            pair workers: an auditor checks the work before you see it
    autopilot.ts         the office running itself: hand-outs, approvals, wrap-ups, interns
    lessons.ts, sync.ts  what the team learns, and the end-of-day sync
    skills.ts            each agent CLI's skills
    doing.ts             what an agent is doing, in a word or three, from its screen
  client/
    main.ts              glue: networking, interaction, the game loop
    scene/               world, player, office, rooms, game room, floor 2, the grounds out back, minigames, hand, characters, boards
    ui/                  HUD, stand-up, goals, assignment card, team policy, review, laptop,
                         decks, arcade, fast travel, minimap, goal card, settings, Arnold,
                         projects, team, MCP, invite/join, logs, icons, idea board, sketchpad,
                         phone, reminders, history, activities (darts, piano, fishing…)
    vr/                  VR: the WebXR session and controllers, floating panels, what you do in VR
electron/
  main.ts                desktop shell: picks the project, starts the server, opens a window
build/                   the app icon (for the installer)
docs/screenshots/        the pictures in this README
```

## Roadmap

Next up, after v1.0:

- **Smoother still, the rest.** First looks no longer hitch, and static
  furniture is drawn merged (about 40% fewer draw calls in the scene, its
  outlines and its shadows). Still to do: the outline pass is a second draw
  of everything on screen (now ~0.7× the scene's calls), and the people,
  the Kenney models and the props you can use aren't merged. Measure with
  `scripts/perf/`.
- **macOS and Linux**, tested end to end (the builds exist; they haven't been
  run on real machines yet).
- **VR**, back on track: the last fixes for drawing and reviews in the headset.
- **A design cleanup.** The HUD has grown: fewer, clearer dock buttons, one
  place for what needs you (questions, reviews, offers), quieter toasts, and
  a consistent look across the monitor, laptop, phone and windows.
- **Voice in the desktop app, on a real Mac.** The 🎤 button starts Windows
  voice typing (Win+H, checked on Windows 11) and macOS dictation (Start
  Dictation, covered by unit tests only); next, trying it on a real Mac, and
  a full run on Windows with the app's window in front.
- **GitHub, against the real thing.** `npm run e2e:real` can now target a
  real test repository (`E2E_GITHUB_REPO` + `E2E_GITHUB_TOKEN`, and it cleans
  up after itself); what's left is actually running it against one and
  fixing whatever real GitHub turns up.

## Credits

The office's look and floor plan are inspired by
[Agent Office](https://github.com/AgentSystemLabs/agent-office) (MIT).

## License

MIT
