// plugin/hub-client.ts — resilient WebSocket client for the claude-web hub.
// Connects to the hub's /agent endpoint, sends the hello frame on every
// successful open, and reconnects forever with bounded exponential backoff.

export interface HubClientOptions {
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

type FrameHandler = (frame: Record<string, unknown>) => void;

export class HubClient {
  private url: string;
  private hello: object;
  private minBackoffMs: number;
  private maxBackoffMs: number;

  private socket: WebSocket | null = null;
  private handlers: FrameHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  constructor(url: string, hello: object, opts?: HubClientOptions) {
    this.url = url;
    this.hello = hello;
    this.minBackoffMs = opts?.minBackoffMs ?? 1000;
    this.maxBackoffMs = opts?.maxBackoffMs ?? 10000;
  }

  /** Wire a listener for frames pushed by the hub. Returns an unsubscribe fn. */
  on(handler: FrameHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /** Start connecting (and keep reconnecting until close()). */
  connect(): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    this.openSocket();
  }

  /** True only while a socket is actually open. */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Send a frame; returns false when no socket is open. Never throws. */
  send(frame: object): boolean {
    if (!this.connected) return false;
    try {
      this.socket!.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Stop reconnecting and drop any open socket. Idempotent. */
  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  }

  private openSocket(): void {
    if (this.closed) return;
    // Drop any stale socket before opening a new one.
    const stale = this.socket;
    this.socket = null;
    if (stale) {
      try {
        stale.close();
      } catch {
        // ignore
      }
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      if (this.socket !== ws) return; // stale socket callback
      this.attempt = 0;
      this.sendHello();
    };
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return; // stale socket callback
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return; // ignore non-JSON
      }
      if (frame === null || typeof frame !== "object") return;
      for (const h of [...this.handlers]) {
        try {
          h(frame as Record<string, unknown>);
        } catch (err) {
          console.error("[claude-web] hub frame handler failed:", err);
        }
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws) return; // a stale socket must not reschedule the live one
      this.socket = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose always follows; nothing to do here.
    };
    this.socket = ws;
  }

  private sendHello(): void {
    try {
      this.socket?.send(JSON.stringify(this.hello));
    } catch (err) {
      console.error("[claude-web] failed to send hello:", err);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    const base = Math.min(this.minBackoffMs * 2 ** this.attempt, this.maxBackoffMs);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
