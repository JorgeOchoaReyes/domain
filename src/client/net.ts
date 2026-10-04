import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

/**
 * Thin, reconnecting WebSocket client.
 *
 * It owns the socket, serializes outgoing ClientMessages, and dispatches
 * incoming ServerMessages to a single handler. Reconnection uses a capped
 * backoff so a server restart heals on its own.
 */
export class Net {
  private ws: WebSocket | null = null;
  private url: string;
  private backoff = 500;
  private closed = false;
  private queue: ClientMessage[] = [];

  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  constructor() {
    this.url = Net.resolveUrl();
  }

  private static resolveUrl(): string {
    // In the Vite dev server the page is on :5173 but the game server is on
    // :8787. In production the server serves the page, so same host/port.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    if (import.meta.env.DEV) {
      return `${proto}//${location.hostname}:8787`;
    }
    return `${proto}//${location.host}`;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
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

    ws.onclose = () => {
      this.onStatus(false);
      if (this.closed) return;
      setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };

    ws.onerror = () => ws.close();
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
