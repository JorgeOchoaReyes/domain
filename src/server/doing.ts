/**
 * What an agent is doing, in a word or three, read off its screen: the latest
 * step its CLI printed. Claude Code shows tool calls as "● Read(src/a.ts)",
 * "● Update(math.js)", "● Bash(npm test)", "● github - create_issue (MCP)";
 * Codex as "• Ran npm test", "• Edited math.js", "• Exploring"; Gemini CLI as
 * "✓ ReadFile math.js", "✓ Shell npm test". Anything else that's busy is
 * "Thinking".
 */

const FILE = (p: string) => {
  const base = p.replace(/["'`]/g, "").trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  return base.length > 18 ? base.slice(0, 17) + "…" : base;
};

/** A shell command, in a couple of words. */
export function commandWords(cmd: string): string {
  const c = cmd.trim().replace(/^\$\s*/, "");
  if (/\b(test|vitest|jest|pytest|mocha|node --test|cargo test|go test)\b/i.test(c)) return "Running tests";
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|pip install|cargo add/i.test(c)) return "Installing";
  if (/\bgit\s+commit\b/i.test(c)) return "Committing";
  if (/\bgit\s+push\b/i.test(c)) return "Pushing";
  if (/\bgit\s+(diff|log|status|show|cat-file|branch)\b/i.test(c)) return "Checking git";
  if (/\b(build|tsc|vite build|webpack|cargo build|make)\b/i.test(c)) return "Building";
  if (/\b(lint|eslint|prettier|ruff|biome)\b/i.test(c)) return "Linting";
  if (/^(ls|dir|cat|type|head|tail|get-content|get-childitem|rg|grep|find|select-string)\b/i.test(c)) return "Looking around";
  const first = c.split(/\s+/)[0]?.replace(/^.*[\\/]/, "") ?? "";
  return first ? `Running ${first.slice(0, 14)}` : "Running a command";
}

/** One screen line → what it says the agent is doing, or null if it's not a step. */
export function stepOf(line: string): string | null {
  const l = line.trim();
  // Claude Code: ● Tool(args)
  let m = /^[●⏺•✓✔⎿]\s*([A-Z][A-Za-z]+)\((.*?)\)?\s*$/.exec(l);
  if (m) {
    const [, tool, arg] = m;
    if (/^(Read|ReadFile|View|Open)$/.test(tool)) return `Reading ${FILE(arg)}`.trim();
    if (/^(Update|Edit|MultiEdit|Write|WriteFile|Create|NotebookEdit)$/.test(tool)) return `Editing ${FILE(arg)}`.trim();
    if (/^(Bash|Shell|PowerShell|Run)$/.test(tool)) return commandWords(arg);
    if (/^(Search|Grep|Glob|Find|List|LS)$/.test(tool)) return "Searching";
    if (/^(WebSearch|WebFetch|Fetch)$/.test(tool)) return "Browsing the web";
    if (/^(Task|Agent)$/.test(tool)) return "Delegating";
    if (/^(TodoWrite|Update Todos)$/.test(tool)) return "Planning";
    return tool.length <= 14 ? tool : null;
  }
  // An MCP tool: "● github - create_issue (MCP)" / "playwright:navigate".
  m = /^[●⏺•✓✔]\s*([A-Za-z0-9_.-]+)\s*(?:-|:)\s*[A-Za-z0-9_]+.*\(MCP\)/.exec(l);
  if (m) return `Using ${m[1].slice(0, 14)}`;
  if (/^[●⏺]\s*Update Todos/.test(l)) return "Planning";
  // Codex: • Ran <cmd> / • Running <cmd> / • Edited <file> / • Exploring / • Read <file>
  m = /^[•◦]\s*(Ran|Running)\s+(.+)$/.exec(l);
  if (m) return commandWords(m[2]);
  m = /^[•◦]\s*(Edited|Editing|Added|Deleted|Updated)\s+(\S+)/.exec(l);
  if (m) return `Editing ${FILE(m[2])}`;
  if (/^[•◦]\s*Exploring\b/.test(l)) return "Exploring";
  m = /^└\s*(Read|Search|List)\s+(\S+)/.exec(l);
  if (m) return m[1] === "Read" ? `Reading ${FILE(m[2])}` : "Searching";
  // Gemini CLI: ✓ ReadFile math.js / ✓ Shell npm test / ✓ WriteFile x
  m = /^[✓✔⊷o]\s*(ReadFile|ReadManyFiles|WriteFile|Edit|Shell|SearchText|FindFiles|GoogleSearch|WebFetch)\s+(.*)$/.exec(l);
  if (m) {
    const [, tool, arg] = m;
    if (/^Read/.test(tool)) return `Reading ${FILE(arg.split(/\s+/)[0])}`;
    if (tool === "WriteFile" || tool === "Edit") return `Editing ${FILE(arg.split(/\s+/)[0])}`;
    if (tool === "Shell") return commandWords(arg);
    if (tool === "GoogleSearch" || tool === "WebFetch") return "Browsing the web";
    return "Searching";
  }
  return null;
}

/** The screen's latest step, or "Thinking" if it's busy with none showing. */
export function doingFrom(screen: string[]): string {
  for (let i = screen.length - 1; i >= 0; i--) {
    const s = stepOf(screen[i]);
    if (s) return s;
  }
  return "Thinking";
}
