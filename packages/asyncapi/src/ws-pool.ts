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
 * The pool is transport-only: it preserves text frames and converts binary
 * frame bytes to strict UTF-8 strings without interpreting their application
 * payload. An acquire may carry an AbortSignal; aborting while the dial is in
 * flight rejects the acquire, and the socket — if it lands later — is parked
 * for reuse and reaped by the idle timer.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** @internal Implementation detail of the asyncapi invoker; not public API. */
export interface PooledWS {
  /** The underlying WebSocket. */
  ws: WebSocket;
  /**
   * Add a raw-frame listener. A binary frame that is not valid UTF-8 is
   * delivered as decodeError rather than silently replacement-decoded.
   * Returns a removal function.
   */
  onMessage(handler: (data: string, decodeError?: Error) => void): () => void;
  /**
   * Add a close listener; called with an Error for socket errors and with
   * undefined for a clean close. Returns a removal function.
   */
  onClose(handler: (err?: Error) => void): () => void;
  /**
   * Send a frame on the shared socket. Throws when the socket is not open:
   * silently dropping frames would let a publish complete "successfully"
   * after the connection died.
   */
  send(data: string | Uint8Array): void;
  /** Release this reference. Starts idle timer if last ref. */
  release(): void;
}

export interface AcquireOptions {
  /** Custom URL builder (e.g. to add query-param credentials). */
  buildURL?: (base: string, addr: string) => string;
  /**
   * Fingerprint of the credential identity a dial would use (invoke.ts's
   * wsUpgradeMaterial hashes exactly the upgrade-request material — no
   * credential rides in-band under openbindings.asyncapi@2 §9.5, so the
   * upgrade request IS the connection's credential identity). Included in
   * the pool key alongside server/address: two acquires with different
   * credential fingerprints MUST NOT share a connection (cross-tenant
   * credential leak — the same property the Go SDK's `wsPoolKey` enforces
   * via its SHA-256 credential digest). Omitted or empty means "no
   * credentials", which still partitions correctly (two anonymous callers
   * share).
   */
  credentialKey?: string;
  /**
   * Headers for the upgrade request (credential placement plus resolved
   * ws-binding header values, §9.5/§8). Applied on runtimes whose WebSocket
   * constructor accepts a headers option (Node's undici does; the WHATWG
   * surface browsers implement does not — there the constructor rejects the
   * option LOUDLY, per §9.5's "surfaced, never silently dropped" floor for
   * carriage the platform cannot apply).
   */
  headers?: Record<string, string>;
  /** Aborts a dial in flight; the acquire rejects with the signal's reason. */
  signal?: AbortSignal;
}

interface PoolEntry {
  ws: WebSocket;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  messageHandlers: Set<(data: string, decodeError?: Error) => void>;
  closeHandlers: Set<(err?: Error) => void>;
  ready: Promise<void>;
  key: string;
}

/** @internal Implementation detail of the asyncapi invoker; not public API. */
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
    const { buildURL, credentialKey, headers, signal } = options;
    if (signal?.aborted) throw abortError(signal);

    const key = poolKey(serverURL, address, credentialKey);

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
    const createPromise = this.createEntry(key, serverURL, address, buildURL, headers);
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
    headers?: Record<string, string>,
  ): Promise<PoolEntry> {
    const url = buildURL
      ? buildURL(serverURL, address)
      : new URL(`/${address.replace(/^\/+/, "")}`, serverURL).toString();

    // Credentials and resolved ws-binding headers ride the UPGRADE REQUEST
    // (§9.5, ASYNC-P-07: no credential ever rides a message body or a first
    // frame). Node's WebSocket (undici) accepts a non-standard `headers`
    // init option; on a WHATWG-only runtime (browsers) the option is not
    // applicable and the constructor errors LOUDLY — surfaced, never
    // silently dropped or rerouted, per §9.5. When there is no header
    // material the standard one-argument form is used everywhere.
    const ws =
      headers && Object.keys(headers).length > 0
        ? new WebSocket(url, { headers } as unknown as string[])
        : new WebSocket(url);
    // WHATWG WebSocket otherwise exposes binary frames as Blob in browsers.
    // ArrayBuffer gives us one synchronous, ordered byte path in browser and
    // Node implementations.
    ws.binaryType = "arraybuffer";

    const messageHandlers = new Set<(data: string, decodeError?: Error) => void>();
    const closeHandlers = new Set<(err?: Error) => void>();

    ws.addEventListener("message", (ev) => {
      try {
        const data = strictUTF8Frame(ev.data);
        for (const handler of messageHandlers) {
          handler(data);
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        for (const handler of messageHandlers) {
          handler("", err);
        }
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

      onMessage(handler: (data: string, decodeError?: Error) => void): () => void {
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

      send(data: string | Uint8Array): void {
        if (entry.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket is not open");
        }
        entry.ws.send(data);
      },

      release: () => {
        entry.refCount--;
        this.startIdleTimer(entry);
      },
    };
  }

  /** @internal Test/diagnostic hook: the current ref count for a pooled key. */
  refCount(serverURL: string, address: string, credentialKey?: string): number {
    return this.conns.get(poolKey(serverURL, address, credentialKey))?.refCount ?? 0;
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

/**
 * Preserves WebSocket message bytes at the OpenBindings string boundary.
 * Text frames already arrive as validated DOMStrings. Binary frames may
 * carry JSON/text bytes, but revision 1 has no opaque bytes value, so they
 * must be strict UTF-8 rather than implementation stringification.
 */
function strictUTF8Frame(data: unknown): string {
  if (typeof data === "string") return data;

  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new Error("WebSocket binary message was not exposed as an ArrayBuffer");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("WebSocket message payload is not valid UTF-8");
  }
}

// ---------------------------------------------------------------------------
// Pool key
// ---------------------------------------------------------------------------

/**
 * Builds the pool key from server URL, channel address, and credential
 * fingerprint. The credential component is load-bearing: two acquires that
 * differ only in credentials must land in different partitions, or a
 * pooled connection authenticated for one caller could be handed to
 * another (cross-tenant credential leak). An absent/empty fingerprint
 * still partitions consistently — "no credentials" is its own bucket.
 */
function poolKey(serverURL: string, address: string, credentialKey?: string): string {
  return `${serverURL}|${address}|${credentialKey ?? ""}`;
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
