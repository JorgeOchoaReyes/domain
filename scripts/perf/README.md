# Measuring smoothness

Scripts that drive the office in headless Chrome (on your real GPU) and say
where frame time goes. They expect a simulated office and a dev client:

```sh
DOMAIN_SIMULATE=1 PORT=8799 DOMAIN_CWD=/tmp/bench npx tsx src/server/index.ts &
VITE_SERVER_PORT=8799 npx vite --port 5199 --strictPort &
```

- `profile.mjs <outDir> [office|outside]` — hires 8 workers, gives them work,
  walks for 10 s: frame times (p50/p95/p99, frames over 33 ms), main-thread
  milliseconds per frame, and the top functions. `NOPROF=1` measures without
  the profiler (it adds its own hitches). Writes a `.cpuprofile`.
- `first-visits.mjs` — the worst frame on the first look at each area vs the
  second: a gap means something is still compiled or uploaded on first sight.
  `SPOT="lobby" OUT=lobby.cpuprofile` profiles that one visit.
- `attribute.mjs <file.cpuprofile>` — time per function of our own code.
- `longest-stretch.mjs <file.cpuprofile>` — what the longest busy stretch was.

Chrome is expected at `C:/Program Files/Google/Chrome/Application/chrome.exe`.
