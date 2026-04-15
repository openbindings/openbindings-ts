/**
 * WebSocket connection pool for the AsyncAPI executor.
 *
 * Multiple operations on the same channel (same server + address) share
 * a single WebSocket connection. This is load-bearing for the AsyncAPI
 * two-operation pattern where a `receive` operation opens a long-lived
 * stream and `send` operations push messages on the same channel.
 *
 * Without pooling, each executeBinding call opens a separate WebSocket
 * and the server (e.g. a Durable Object) tracks subscriptions per-socket,
 * so send and receive never share state.
 *
 * Lifecycle:
 *   - First acquire() for a key dials the WebSocket.
 *   - Subsequent acquire() calls for the same key reuse it.
 *   - Each acquire() increments a ref count; release() decrements.
 *   - When refCount hits 0, an idle timer starts (default 30s).
 *   - If no new acquire() arrives before the timer fires, the socket
 *     is closed and evicted.
 */

import type { StreamEvent } from "@openbindings/sdk";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface PooledWS {
  /** The underlying WebSocket. */
  ws: WebSocket;
  /** Add a message listener. Returns a removal function. */
  onMessage(handler: (event: StreamEvent) => void): () => void;
  /** Add a close/error listener. Returns a removal function. */
  onClose(handler: () => void): () => void;
  /** Send a message on the shared socket. */
  send(data: string): void;
  /** Release this reference. Starts idle timer if last ref. */
  release(): void;
}

interface PoolEntry {
  ws: WebSocket;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  messageHandlers: Set<(event: StreamEvent) => void>;
  closeHandlers: Set<() => void>;
  ready: Promise<void>;
  key: string;
}

export class WSPool {
  private conns = new Map<string, PoolEntry>();
  private creating = new Map<string, Promise<PoolEntry>>();
  private idleTimeoutMs: number;

  constructor(idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
    this.idleTimeoutMs = idleTimeoutMs;
  }

  /**
   * Acquire a pooled WebSocket for the given server URL and channel address.
   * Creates one if none exists. Increments ref count.
   */
  async acquire(
    serverURL: string,
    address: string,
    buildURL?: (base: string, addr: string) => string,
  ): Promise<PooledWS> {
    const key = `${serverURL}|${address}`;

    // Fast path: reuse existing connection.
    const existing = this.conns.get(key);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) {
      if (existing.idleTimer !== null) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.refCount++;
      await existing.ready;
      return this.wrap(existing);
    }

    // Check if another call is already creating this connection.
    const pending = this.creating.get(key);
    if (pending) {
      const entry = await pending;
      entry.refCount++;
      return this.wrap(entry);
    }

    // Create a new connection.
    const createPromise = this.createEntry(key, serverURL, address, buildURL);
    this.creating.set(key, createPromise);

    let entry: PoolEntry;
    try {
      entry = await createPromise;
    } finally {
      this.creating.delete(key);
    }

    entry.refCount = 1;
    this.conns.set(key, entry);
    return this.wrap(entry);
  }

  private async createEntry(
    key: string,
    serverURL: string,
    address: string,
    buildURL?: (base: string, addr: string) => string,
  ): Promise<PoolEntry> {
    const url = buildURL
      ? buildURL(serverURL, address)
      : new URL(`/${address.replace(/^\/+/, "")}`, serverURL).toString();

    const ws = new WebSocket(url);

    const messageHandlers = new Set<(event: StreamEvent) => void>();
    const closeHandlers = new Set<() => void>();

    ws.addEventListener("message", (ev) => {
      let event: StreamEvent;
      try {
        const parsed = JSON.parse(String(ev.data));
        if (parsed.error) {
          event = { error: parsed.error };
        } else if (parsed.data !== undefined) {
          event = { data: parsed.data };
        } else {
          event = { data: parsed };
        }
      } catch {
        event = { data: String(ev.data) };
      }
      for (const handler of messageHandlers) {
        handler(event);
      }
    });

    ws.addEventListener("close", () => {
      for (const handler of closeHandlers) {
        handler();
      }
      this.conns.delete(key);
    });

    ws.addEventListener("error", () => {
      for (const handler of closeHandlers) {
        handler();
      }
      this.conns.delete(key);
    });

    const ready = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });

    const entry: PoolEntry = {
      ws,
      refCount: 0,
      idleTimer: null,
      messageHandlers,
      closeHandlers,
      ready,
      key,
    };

    await ready;
    return entry;
  }

  private wrap(entry: PoolEntry): PooledWS {
    return {
      ws: entry.ws,

      onMessage(handler: (event: StreamEvent) => void): () => void {
        entry.messageHandlers.add(handler);
        return () => { entry.messageHandlers.delete(handler); };
      },

      onClose(handler: () => void): () => void {
        entry.closeHandlers.add(handler);
        return () => { entry.closeHandlers.delete(handler); };
      },

      send(data: string): void {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(data);
        }
      },

      release: () => {
        entry.refCount--;
        if (entry.refCount <= 0) {
          entry.idleTimer = setTimeout(() => {
            const current = this.conns.get(entry.key);
            if (current === entry) {
              this.conns.delete(entry.key);
              if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
                entry.ws.close(1000, "idle timeout");
              }
            }
          }, this.idleTimeoutMs);
        }
      },
    };
  }

  /** Close all pooled connections. */
  closeAll(): void {
    for (const [, entry] of this.conns) {
      if (entry.idleTimer !== null) {
        clearTimeout(entry.idleTimer);
      }
      if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
        entry.ws.close(1000, "pool closed");
      }
    }
    this.conns.clear();
  }
}
