// A stand-in for an agent CLI, run in a real terminal by the office's tests.
// It draws a screen, logs every line typed into it (to typed.log in its
// folder), shows a permission menu when a line says ASK, and quits on QUIT.
import { appendFileSync } from "node:fs";

const log = (s) => appendFileSync("typed.log", s + "\n");
const banner = "╭" + "─".repeat(70) + "╮\n" + ("│ Fake Agent — ready for work" + " ".repeat(42) + "│\n").repeat(12) + "╰" + "─".repeat(70) + "╯\n";
process.stdout.write(banner + "> ");

let asking = false;
let line = "";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const ch of chunk) {
    if (asking) {
      if (ch === "\r") {
        asking = false;
        log("ANSWERED");
        process.stdout.write("\x1b[2J\x1b[H" + banner + "> ");
      } else log("TYPED INTO MENU: " + JSON.stringify(ch));
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const got = line;
      line = "";
      if (!got.trim()) continue;
      log("LINE: " + got);
      if (/QUIT/.test(got)) process.exit(0);
      if (/ASK/.test(got)) {
        asking = true;
        process.stdout.write("\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n");
      } else process.stdout.write("\r\nok\r\n> ");
      continue;
    }
    line += ch;
  }
});
