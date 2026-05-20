// ---------------------------------------------------------------------------
// Context store
// ---------------------------------------------------------------------------

/**
 * A key-value store for binding invocation context.
 * Keys are invoker-determined strings (typically a normalized API origin).
 * Values are opaque credential maps using well-known field names for
 * cross-invoker interoperability.
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
 * Functions injected into invokers so they can interact with the runtime
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
// Well-known context helpers
// ---------------------------------------------------------------------------

/** Returns the well-known `bearerToken` field from context, or empty string if absent. */
export function contextBearerToken(ctx: Record<string, unknown> | null | undefined): string {
  if (!ctx) return "";
  const v = ctx["bearerToken"];
  return typeof v === "string" ? v : "";
}

/** Returns the well-known `headers` field from context as a typed string-string map. */
export function contextHeaders(ctx: Record<string, unknown> | null | undefined): Record<string, string> {
  return extractStringMap(ctx, "headers");
}

/** Returns the well-known `cookies` field from context as a typed string-string map. */
export function contextCookies(ctx: Record<string, unknown> | null | undefined): Record<string, string> {
  return extractStringMap(ctx, "cookies");
}

/** Returns the well-known `environment` field from context as a typed string-string map. */
export function contextEnvironment(ctx: Record<string, unknown> | null | undefined): Record<string, string> {
  return extractStringMap(ctx, "environment");
}

/** Returns the well-known `metadata` field from context, or an empty object if absent. */
export function contextMetadata(ctx: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!ctx) return {};
  const raw = ctx["metadata"];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function extractStringMap(ctx: Record<string, unknown> | null | undefined, key: string): Record<string, string> {
  if (!ctx) return {};
  const raw = ctx[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
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
 * Normalizes a URL to a stable context store key. The key is host[:port]
 * (scheme, path, query, and fragment are stripped) so that http:// and
 * https://, and per-path variations, share credentials for the same
 * origin. Non-URL strings are returned as-is.
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

/**
 * Builds an HTTP `Authorization` header (and optional Cookie / merged
 * headers) from a binding context. Reads the well-known fields:
 *
 *   - bearerToken    → `Authorization: Bearer <token>`
 *   - apiKey         → `Authorization: ApiKey <key>` (no securityScheme awareness)
 *   - basic          → `Authorization: Basic <base64>`
 *   - headers        → merged verbatim
 *   - cookies        → merged into a single `Cookie` header
 *
 * `bearerToken` wins over `apiKey` which wins over `basic`. Format
 * invokers that need scheme-aware placement (OpenAPI, AsyncAPI) should
 * resolve the security scheme themselves and not use this helper.
 */
export function buildAuthHeaders(ctx: Record<string, unknown> | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!ctx) return headers;

  const bearer = contextBearerToken(ctx);
  if (bearer) {
    headers["Authorization"] = `Bearer ${bearer}`;
  } else {
    const apiKey = contextApiKey(ctx);
    if (apiKey) {
      headers["Authorization"] = `ApiKey ${apiKey}`;
    } else {
      const basic = contextBasicAuth(ctx);
      if (basic) {
        headers["Authorization"] = `Basic ${btoa(`${basic.username}:${basic.password}`)}`;
      }
    }
  }
  for (const [k, v] of Object.entries(contextHeaders(ctx))) {
    headers[k] = v;
  }
  const pairs = Object.entries(contextCookies(ctx)).map(([k, v]) => `${k}=${v}`).sort();
  if (pairs.length > 0) headers["Cookie"] = pairs.join("; ");
  return headers;
}

/**
 * Normalizes a remote endpoint URL to a context store key. Parses the
 * URL and returns `normalizeContextKey(host)`; falls back to
 * `normalizeContextKey(url)` for non-URL strings.
 */
export function normalizeEndpoint(url: string): string {
  try {
    return normalizeContextKey(new URL(url).host);
  } catch {
    return normalizeContextKey(url);
  }
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

/** Thrown when an invoker cannot proceed because required context (credentials, configuration) is missing. */
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
