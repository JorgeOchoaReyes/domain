import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

/**
 * Thin, reconnecting WebSocket client.
 *
 * It owns the socket, serializes outgoing ClientMessages, and dispatches
 * incoming ServerMessages to a single handler. Reconnection uses a capped
 * backoff so a server restart heals on its own.
 *
 * A guest joining over the local network connects with the host's passcode.
 * If the host stops sharing, or the office can't be reached any more, it
 * stops retrying and says why (onGiveUp), so the join card can come back.
 */

/** Close code the host's office uses when it stops sharing. */
export const STOPPED_SHARING = 4001;

export class Net {
  private ws: WebSocket | null = null;
  private url: string;
  private backoff = 500;
  private closed = false;
  private queue: ClientMessage[] = [];
  private code: string | null = null;
  /** Connection attempts in a row that never opened. */
  private failed = 0;

  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  /** A guest's connection gave up: the host stopped sharing, or the office can't be reached (wrong code, gone). */
  onGiveUp: ((reason: "stopped" | "unreachable") => void) | null = null;

  constructor() {
    this.url = Net.resolveUrl(null);
  }

  private static resolveUrl(code: string | null): string {
    // In the Vite dev server the page is on :5173 but the game server is on
    // :8787 (or VITE_SERVER_PORT, to run a second copy alongside). In
    // production the server serves the page, so same host/port.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const query = code ? `/?code=${encodeURIComponent(code)}` : "";
    if (import.meta.env.DEV) {
      return `${proto}//${location.hostname}:${import.meta.env.VITE_SERVER_PORT || 8787}${query}`;
    }
    return `${proto}//${location.host}${query}`;
  }

  /** Join with a passcode (a guest on the local network). Takes effect on the next connect. */
  setPasscode(code: string | null): void {
    this.code = code;
    this.url = Net.resolveUrl(code);
    this.failed = 0;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.failed = 0;
      this.backoff = 500;
      this.onStatus(true);
      // Flush anything queued while disconnected.
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) this.send(m);
    };

    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onclose = (ev) => {
      this.onStatus(false);
      if (this.closed) return;
      if (this.code) {
        // A guest: the host ended it, or the office keeps refusing us.
        if (ev.code === STOPPED_SHARING) return this.giveUp("stopped");
        if (!opened && ++this.failed >= 4) return this.giveUp("unreachable");
      }
      setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };

    ws.onerror = () => ws.close();
  }

  private giveUp(reason: "stopped" | "unreachable"): void {
    this.closed = true;
    this.onGiveUp?.(reason);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else if (msg.t === "join") {
      // Make sure the join is re-sent once reconnected.
      this.queue = [msg, ...this.queue.filter((m) => m.t !== "join")];
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
