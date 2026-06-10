/**
 * WebSocket connection pool for the AsyncAPI invoker.
 *
 * Multiple operations on the same channel (same server + address) share
 * a single WebSocket connection. This is load-bearing for the AsyncAPI
 * two-operation pattern where a `receive` operation opens a long-lived
 * stream and `send` operations push messages on the same channel.
 *
 * Without pooling, each invokeBinding call opens a separate WebSocket
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
 *
 * The pool is transport-only: it delivers raw frame strings and never
 * interprets payloads. An acquire may carry an AbortSignal; aborting
 * while the dial is in flight rejects the acquire, and the socket — if
 * it lands later — is parked for reuse and reaped by the idle timer.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface PooledWS {
  /** The underlying WebSocket. */
  ws: WebSocket;
  /** Add a raw-frame listener. Returns a removal function. */
  onMessage(handler: (data: string) => void): () => void;
  /**
   * Add a close listener; called with an Error for socket errors and with
   * undefined for a clean close. Returns a removal function.
   */
  onClose(handler: (err?: Error) => void): () => void;
  /** Send a frame on the shared socket. */
  send(data: string): void;
  /** Release this reference. Starts idle timer if last ref. */
  release(): void;
}

export interface AcquireOptions {
  /** Custom URL builder (e.g. to add query-param credentials). */
  buildURL?: (base: string, addr: string) => string;
  /** Aborts a dial in flight; the acquire rejects with the signal's reason. */
  signal?: AbortSignal;
}

interface PoolEntry {
  ws: WebSocket;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  messageHandlers: Set<(data: string) => void>;
  closeHandlers: Set<(err?: Error) => void>;
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
    options: AcquireOptions = {},
  ): Promise<PooledWS> {
    const { buildURL, signal } = options;
    if (signal?.aborted) throw abortError(signal);

    const key = `${serverURL}|${address}`;

    // Fast path: reuse existing connection (already ready by construction).
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
      const entry = await abortable(pending, signal);
      entry.refCount++;
      return this.wrap(entry);
    }

    // Create a new connection.
    const createPromise = this.createEntry(key, serverURL, address, buildURL);
    this.creating.set(key, createPromise);

    let entry: PoolEntry;
    try {
      entry = await abortable(createPromise, signal);
    } catch (e: unknown) {
      if (signal?.aborted) {
        // The dial continues in the background: park the socket for reuse
        // when it lands and let the idle timer reap it.
        void createPromise
          .then((late) => {
            this.creating.delete(key);
            if (!this.conns.has(key)) {
              this.conns.set(key, late);
              this.startIdleTimer(late);
            }
          })
          .catch(() => {
            this.creating.delete(key);
          });
      } else {
        this.creating.delete(key);
      }
      throw e;
    }

    this.creating.delete(key);
    entry.refCount++;
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

    const messageHandlers = new Set<(data: string) => void>();
    const closeHandlers = new Set<(err?: Error) => void>();

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      for (const handler of messageHandlers) {
        handler(data);
      }
    });

    ws.addEventListener("close", () => {
      for (const handler of closeHandlers) {
        handler(undefined);
      }
      this.conns.delete(key);
    });

    ws.addEventListener("error", () => {
      for (const handler of closeHandlers) {
        handler(new Error("WebSocket error"));
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

  private startIdleTimer(entry: PoolEntry): void {
    if (entry.refCount > 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      const current = this.conns.get(entry.key);
      if (current === entry && entry.refCount <= 0) {
        this.conns.delete(entry.key);
        if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
          entry.ws.close(1000, "idle timeout");
        }
      }
    }, this.idleTimeoutMs);
  }

  private wrap(entry: PoolEntry): PooledWS {
    return {
      ws: entry.ws,

      onMessage(handler: (data: string) => void): () => void {
        entry.messageHandlers.add(handler);
        return () => {
          entry.messageHandlers.delete(handler);
        };
      },

      onClose(handler: (err?: Error) => void): () => void {
        entry.closeHandlers.add(handler);
        return () => {
          entry.closeHandlers.delete(handler);
        };
      },

      send(data: string): void {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(data);
        }
      },

      release: () => {
        entry.refCount--;
        this.startIdleTimer(entry);
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

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("WebSocket acquire aborted");
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
