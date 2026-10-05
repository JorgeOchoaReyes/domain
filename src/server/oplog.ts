import { randomUUID } from "node:crypto";
import type { OpLog, OpTool } from "../shared/project.js";

/**
 * The operations log: every git, GitHub, MCP, check and deploy step the
 * office runs for you, with its command and output, so you can always see
 * what happened. Kept in memory (the last 200), streamed to every client.
 */

const KEEP = 200;
const TAIL = 8000;

export interface OpHandle {
  readonly id: string;
  /** Add output (it's kept to the tail). */
  append(text: string): void;
  /** Finish: ok or error, with an optional last word and a link. */
  done(ok: boolean, detail?: string, url?: string): void;
}

export class OpLogger {
  private entries: OpLog[] = [];
  /** Called with the entry each time one starts, grows or finishes. */
  onEntry: ((e: OpLog) => void) | null = null;

  start(tool: OpTool, title: string, opts: { command?: string; topic?: string } = {}): OpHandle {
    const e: OpLog = { id: randomUUID().slice(0, 8), at: Date.now(), tool, title, command: opts.command, topic: opts.topic, status: "running", output: "" };
    this.entries.unshift(e);
    if (this.entries.length > KEEP) this.entries.length = KEEP;
    this.emit(e);
    let pending: NodeJS.Timeout | null = null;
    const flush = () => {
      pending = null;
      this.emit(e);
    };
    return {
      id: e.id,
      append: (text: string) => {
        e.output = (e.output + text).slice(-TAIL);
        // Output can stream fast (git clone --progress): send it at most ~8 times a second.
        if (!pending) pending = setTimeout(flush, 120);
      },
      done: (ok: boolean, detail?: string, url?: string) => {
        if (pending) clearTimeout(pending);
        e.status = ok ? "ok" : "error";
        if (detail) e.output = (e.output + (e.output && !e.output.endsWith("\n") ? "\n" : "") + detail).slice(-TAIL);
        if (url) e.url = url;
        this.emit(e);
      },
    };
  }

  all(): OpLog[] {
    return this.entries.map((e) => ({ ...e }));
  }

  private emit(e: OpLog): void {
    this.onEntry?.({ ...e });
  }
}
