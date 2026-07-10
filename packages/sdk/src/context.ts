import type { ContextRequiredDetails } from "./invocation.js";
import { REQUIREMENT_FIELDS } from "./invocation.js";
import type { ContextResolver } from "./invokers.js";

// ---------------------------------------------------------------------------
// Context store
// ---------------------------------------------------------------------------

/**
 * A key-value store for binding invocation context.
 * Keys are invoker-determined strings (typically a normalized API origin).
 * Values are opaque context records — credentials, headers, cookies,
 * environment, metadata — using well-known field names for cross-invoker
 * interoperability.
 *
 * The well-known credential fields, by the requirement family they satisfy:
 *
 * ```text
 * auth.bearer  →  "bearerToken"
 * auth.apiKey  →  "apiKey"
 * auth.basic   →  "basic" (a { username, password } object)
 * auth.oauth2  →  "accessToken" (plus "refreshToken", "clientSecret")
 * ```
 *
 * so satisfying a bearer challenge for an origin is one call:
 *
 * ```ts
 * await store.set(normalizeContextKey(target), { bearerToken: token });
 * ```
 *
 * The SDK stores and retrieves context but never inspects its contents.
 * Setting null removes the entry (the published contract pins
 * set-null ≡ delete, so get's null uniformly means "no entry").
 * The published openbindings.key-value-store interface standardizes this
 * same get/set/delete capability where a store sits across a wire.
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
// Store-backed context resolver
// ---------------------------------------------------------------------------

/**
 * True when the stored context can satisfy every requirement of at least one
 * alternative. An alternative with no requirements never satisfies (the
 * binding-invoker interface requires at least one requirement per alternative;
 * treating a malformed empty alternative as vacuously satisfied would hand
 * stored context to any challenge).
 */
export function contextSatisfies(
  ctx: Record<string, unknown>,
  details: ContextRequiredDetails,
): boolean {
  return details.alternatives.some(
    (alt) =>
      alt.requirements.length > 0 &&
      alt.requirements.every((req) => {
        const field = REQUIREMENT_FIELDS[req.type] ?? req.type;
        const v = ctx[field];
        return v !== undefined && v !== null && v !== "";
      }),
  );
}

/**
 * Maps a requirement family to every context field that belongs to it.
 * REQUIREMENT_FIELDS names only the field whose presence gates satisfaction;
 * this names the whole family so scoping can admit (for example) an oauth2
 * refresh token alongside its access token. Any field not listed in a family
 * is treated as non-secret configuration.
 */
const REQUIREMENT_FAMILY_FIELDS: Record<string, string[]> = {
  "auth.bearer": ["bearerToken"],
  "auth.apiKey": ["apiKey"],
  "auth.basic": ["basic"],
  "auth.oauth2": ["accessToken", "refreshToken", "clientSecret"],
};

const CREDENTIAL_FIELDS = new Set(Object.values(REQUIREMENT_FAMILY_FIELDS).flat());

/**
 * Returns the least-privilege subset of a stored context for a challenge
 * (binding-invoker interface). A CONTEXT_REQUIRED challenge is a scope, not a hint:
 * the invoker receives only what it declared it needs. Every non-secret
 * configuration field passes through unchanged; among the secret credential
 * fields, only those belonging to the requirement families of the first
 * alternative the context satisfies are admitted, and all other stored
 * credentials are withheld. With no challenge there is nothing to scope, so the
 * full context is returned (copied).
 */
export function scopeContext(
  stored: Record<string, unknown>,
  details: ContextRequiredDetails | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Non-secret configuration always passes through.
  for (const [k, v] of Object.entries(stored)) {
    if (!CREDENTIAL_FIELDS.has(k)) out[k] = v;
  }
  if (!details) {
    for (const [k, v] of Object.entries(stored)) {
      if (CREDENTIAL_FIELDS.has(k)) out[k] = v;
    }
    return out;
  }
  for (const alt of details.alternatives) {
    if (alt.requirements.length === 0) continue;
    const satisfied = alt.requirements.every((req) => {
      const field = REQUIREMENT_FIELDS[req.type] ?? req.type;
      const v = stored[field];
      return v !== undefined && v !== null && v !== "";
    });
    if (!satisfied) continue;
    for (const req of alt.requirements) {
      const fields = REQUIREMENT_FAMILY_FIELDS[req.type] ?? [req.type];
      for (const f of fields) {
        if (f in stored) out[f] = stored[f];
      }
    }
    return out;
  }
  return out;
}

/**
 * Builds a read-only {@link ContextResolver} backed by a {@link ContextStore}:
 * the composition of the binding-invoker and context-store contracts. It derives
 * the store key from the challenge's `target` by normalizing it
 * ({@link normalizeEndpoint}), returns the least-privilege subset of the stored
 * context ({@link scopeContext}) when it satisfies one of the challenge's
 * alternatives, and declines (null) otherwise — at which point the challenge
 * surfaces to the caller unchanged. A CONTEXT_REQUIRED challenge is a scope,
 * not a hint: only the satisfied alternative's credentials plus non-secret
 * config are returned, never other stored credentials.
 *
 * A stored entry that does NOT satisfy the challenge (wrong field name, empty
 * value) is a decline like any other: the challenge surfaces, and the
 * {@link InvocationError} message names the requirement family and the context
 * field that would satisfy it — check the stored entry's keys against that
 * field name.
 *
 * Apps that resolve interactively (prompt, browser redirect, keychain)
 * supply their own resolver and MAY persist what they obtain for
 * `durable: true` requirements under the target-derived key; non-durable
 * context MUST NOT be persisted.
 */
export function storeContextResolver(store: ContextStore): ContextResolver {
  return async (details: ContextRequiredDetails) => {
    const ctx = await store.get(normalizeEndpoint(details.target));
    if (!ctx) return null;
    return contextSatisfies(ctx, details) ? scopeContext(ctx, details) : null;
  };
}

