// ---------------------------------------------------------------------------
// Context store
// ---------------------------------------------------------------------------

/**
 * A key-value store for binding execution context.
 * Keys are executor-determined strings (typically a normalized API origin).
 * Values are opaque credential maps using well-known field names for
 * cross-executor interoperability.
 *
 * The SDK stores and retrieves context but never inspects its contents.
 * Async because browser/persistent stores are inherently async.
 */
export interface ContextStore {
  get(key: string): Promise<Record<string, unknown> | null>;
  set(key: string, value: Record<string, unknown> | null): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Platform callbacks
// ---------------------------------------------------------------------------

/** The result of a browser redirect callback, containing the final callback URL. */
export interface BrowserRedirectResult {
  callbackURL: string;
  /** The redirect_uri the platform used in the authorization request. */
  redirectUri?: string;
}

/** Options for a {@link PlatformCallbacks.prompt} invocation. */
export interface PromptOptions {
  label?: string;
  secret?: boolean;
}

/** Options for a {@link PlatformCallbacks.fileSelect} invocation. */
export interface FileSelectOptions {
  label?: string;
  extensions?: string[];
}

/**
 * Functions injected into executors so they can interact with the runtime
 * environment without knowing what platform they're running on.
 * Each field is optional — undefined means the capability is unavailable.
 */
export interface PlatformCallbacks {
  browserRedirect?: (url: string) => Promise<BrowserRedirectResult>;
  prompt?: (message: string, opts?: PromptOptions) => Promise<string>;
  confirmation?: (message: string) => Promise<boolean>;
  fileSelect?: (message: string, opts?: FileSelectOptions) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Execution options (developer-supplied, not stored)
// ---------------------------------------------------------------------------

/**
 * Developer-supplied per-request settings passed through to the executor.
 * Unlike context, options are not stored or resolved.
 */
export interface ExecutionOptions {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  environment?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Well-known context helpers
// ---------------------------------------------------------------------------

/** Returns the well-known `bearerToken` field from context, or empty string if absent. */
export function contextBearerToken(ctx: Record<string, unknown> | null | undefined): string {
  if (!ctx) return "";
  const v = ctx["bearerToken"];
  return typeof v === "string" ? v : "";
}

/** Returns the well-known `apiKey` field from context, or empty string if absent. */
export function contextApiKey(ctx: Record<string, unknown> | null | undefined): string {
  if (!ctx) return "";
  const v = ctx["apiKey"];
  return typeof v === "string" ? v : "";
}

/** Returns the well-known basic auth fields from context, or `null` if absent. */
export function contextBasicAuth(
  ctx: Record<string, unknown> | null | undefined,
): { username: string; password: string } | null {
  if (!ctx) return null;
  const basic = ctx["basic"];
  if (!basic || typeof basic !== "object") return null;
  const b = basic as Record<string, unknown>;
  const username = typeof b["username"] === "string" ? b["username"] : "";
  const password = typeof b["password"] === "string" ? b["password"] : "";
  if (!username && !password) return null;
  return { username, password };
}

/** Returns a string value from context by key, or empty string if absent. */
export function contextString(ctx: Record<string, unknown> | null | undefined, key: string): string {
  if (!ctx) return "";
  const v = ctx[key];
  return typeof v === "string" ? v : "";
}

const REDACTED_KEYS = new Set(["bearerToken", "apiKey", "refreshToken", "accessToken", "clientSecret"]);

/**
 * Returns a shallow copy of ctx with well-known credential fields replaced
 * by "[REDACTED]". Safe for logging and error messages.
 * Returns null for null/undefined input.
 */
export function redactContext(ctx: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!ctx) return null;
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (REDACTED_KEYS.has(k)) {
      redacted[k] = "[REDACTED]";
    } else if (k === "basic" && typeof v === "object" && v !== null) {
      const b = v as Record<string, unknown>;
      redacted[k] = { ...b, ...("password" in b ? { password: "[REDACTED]" } : {}) };
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// normalizeContextKey
// ---------------------------------------------------------------------------

/**
 * Normalizes a URL to a stable context store key.
 * The key is scheme://host (path, query, and fragment are stripped) to
 * enable cross-executor credential sharing for the same API origin.
 * http:// is normalized to https://. Non-URL strings are returned as-is.
 */
export function normalizeContextKey(raw: string): string {
  raw = raw.trim();
  if (!raw) return raw;

  // Strip scheme — the context key is just host[:port].
  // Protocol is irrelevant to origin identity.
  const protoIdx = raw.indexOf("://");
  if (protoIdx < 0) return raw;

  let host = raw.slice(protoIdx + 3);

  // Strip query, fragment, and path.
  const qIdx = host.indexOf("?");
  if (qIdx >= 0) host = host.slice(0, qIdx);
  const hIdx = host.indexOf("#");
  if (hIdx >= 0) host = host.slice(0, hIdx);
  const slashIdx = host.indexOf("/");
  if (slashIdx >= 0) host = host.slice(0, slashIdx);

  return host;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/**
 * In-memory ContextStore for session-scoped usage.
 * Uses structuredClone for isolation (prevents aliasing between
 * callers and the store).
 */
export class MemoryStore implements ContextStore {
  private data = new Map<string, Record<string, unknown>>();

  async get(key: string): Promise<Record<string, unknown> | null> {
    const v = this.data.get(key);
    if (!v) return null;
    return structuredClone(v);
  }

  async set(key: string, value: Record<string, unknown> | null): Promise<void> {
    if (value == null) {
      this.data.delete(key);
      return;
    }
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when an executor cannot proceed because required context (credentials, configuration) is missing. */
export class ContextInsufficientError extends Error {
  constructor(message = "openbindings: context insufficient for this binding") {
    super(message);
    this.name = "ContextInsufficientError";
  }
}

/** Thrown when context is insufficient and no platform callbacks are available to resolve it interactively. */
export class ResolutionUnavailableError extends Error {
  constructor(message = "openbindings: interactive context resolution not available") {
    super(message);
    this.name = "ResolutionUnavailableError";
  }
}
