import type { ContextRequiredDetails, ContextRequirement } from "./invocation.js";
import { REQUIREMENT_FIELDS } from "./invocation.js";
import type { ContextResolver } from "./invokers.js";

// ---------------------------------------------------------------------------
// Context store
// ---------------------------------------------------------------------------

/**
 * An optional SDK storage seam for binding invocation context.
 * Keys are caller-chosen strings. {@link storeContextResolver} uses its own
 * normalized-target convention; other consumers may choose another policy.
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
 * auth.oauth2  →  "accessToken" or "bearerToken" (plus "refreshToken",
 *                 "clientSecret") — an access token rides the wire as a
 *                 Bearer credential, so either spelling answers the family
 * ```
 *
 * so satisfying a bearer challenge for an origin is one call:
 *
 * ```ts
 * await store.set(normalizeContextKey(target), { bearerToken: token });
 * ```
 *
 * `storeContextResolver` inspects standard requirement fields only to satisfy
 * and scope a challenge. Other consumers may treat values as wholly opaque.
 * `delete` removes an entry; `set` accepts an object. The published
 * `openbindings.document-store` interface is the language-neutral wire
 * analogue when this optional seam crosses a process boundary.
 * Async because browser/persistent stores are inherently async.
 */
export interface ContextStore {
  get(key: string): Promise<Record<string, unknown> | null>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
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

/** Returns one named credential value from context.credentials. */
export function contextNamedCredential(
  ctx: Record<string, unknown> | null | undefined,
  name?: string,
): unknown {
  if (!ctx || !name) return undefined;
  const credentials = ctx["credentials"];
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return undefined;
  return (credentials as Record<string, unknown>)[name];
}

/** Returns a named bearer credential, falling back to the flat convenience. */
export function contextBearerTokenFor(
  ctx: Record<string, unknown> | null | undefined,
  name?: string,
): string {
  const named = contextNamedCredential(ctx, name);
  if (typeof named === "string" && named) return named;
  return contextBearerToken(ctx);
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

/**
 * Returns the well-known `configuration` field from context: per-invocation
 * configuration-point values, keyed by point name — the operation-invoker
 * contract's `selection` point, and the named points each binding
 * specification defines for its family (decode, classify, route, solicit,
 * server, address, target, transport). The values' meanings belong to
 * whichever specification defines the point; this helper only provides the
 * carriage. Empty object if absent or not an object.
 */
export function contextConfiguration(ctx: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!ctx) return {};
  const raw = ctx["configuration"];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
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

/** Returns the well-known `apiKeys` field from context as a typed string-string map. */
function contextApiKeys(ctx: Record<string, unknown> | null | undefined): Record<string, string> {
  return extractStringMap(ctx, "apiKeys");
}

/**
 * Resolves the API key for one named requirement: the requirement's
 * `name`-keyed entry in the well-known `apiKeys` map first, falling back to
 * the single well-known `apiKey` convenience when `name` is absent or not
 * carried in the map. This is the one lookup every apiKey-family credential
 * application should use (openapi/asyncapi's scheme-driven placement, and
 * the resolvers above) so two ANDed apiKey schemes with different names
 * resolve to distinct keys instead of colliding on the single `apiKey`
 * field.
 */
export function contextApiKeyFor(
  ctx: Record<string, unknown> | null | undefined,
  name?: string,
): string {
  if (name) {
    const credential = contextNamedCredential(ctx, name);
    if (typeof credential === "string" && credential) return credential;
    const named = contextApiKeys(ctx)[name];
    if (named) return named;
  }
  return contextApiKey(ctx);
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

/** Returns one named basic credential, falling back to the flat convenience. */
export function contextBasicAuthFor(
  ctx: Record<string, unknown> | null | undefined,
  name?: string,
): { username: string; password: string } | null {
  const named = contextNamedCredential(ctx, name);
  if (named && typeof named === "object" && !Array.isArray(named)) {
    const value = named as Record<string, unknown>;
    const username = typeof value["username"] === "string" ? value["username"] : "";
    const password = typeof value["password"] === "string" ? value["password"] : "";
    if (username || password) return { username, password };
  }
  return contextBasicAuth(ctx);
}

/** Returns one named OAuth access token, falling back to flat OAuth context. */
export function contextAccessTokenFor(
  ctx: Record<string, unknown> | null | undefined,
  name?: string,
): string {
  const named = contextNamedCredential(ctx, name);
  if (named && typeof named === "object" && !Array.isArray(named)) {
    const accessToken = (named as Record<string, unknown>)["accessToken"];
    if (typeof accessToken === "string" && accessToken) return accessToken;
  }
  return contextString(ctx, "accessToken");
}

/** Returns a string value from context by key, or empty string if absent. */
export function contextString(ctx: Record<string, unknown> | null | undefined, key: string): string {
  if (!ctx) return "";
  const v = ctx[key];
  return typeof v === "string" ? v : "";
}

/**
 * Reports whether the caller has asserted that this invocation carries no
 * credentials, via the well-known top-level `anonymous: true` field. It is a
 * sibling of `configuration`, not a point inside it: it qualifies the whole
 * invocation rather than any one configuration point.
 *
 * An OpenAPI document's `security` describes what the API ACCEPTS; the server
 * decides what it ENFORCES, and the two routinely disagree — public read
 * endpoints under a blanket document-level requirement are ordinary. Without
 * this, such an operation is unreachable: the challenge cannot be answered
 * truthfully (there is no credential) and answering it falsely is worse than
 * silence, because a rejected token earns a 401 where sending nothing would
 * have been served.
 *
 * The assertion is the caller supplying, for this invocation, exactly what OAS
 * itself spells as `security: []`. It is deliberately an explicit act rather
 * than a fallback: guessing that a declared requirement is decorative would
 * make every credentialed operation silently attempt an unauthenticated call
 * first.
 */
export function contextAnonymous(ctx: Record<string, unknown> | null | undefined): boolean {
  if (!ctx) return false;
  return ctx["anonymous"] === true;
}

/**
 * Returns a shallow copy of ctx with well-known credential fields replaced
 * by "[REDACTED]". Returns null for null/undefined input. Other fields may
 * also contain secrets according to their binding specification or
 * application meaning, so the result is not automatically safe to log
 * without an application-specific second pass.
 *
 * The context-confidentiality invariant: no context value the standard
 * credential taxonomy classifies as secret survives, in cleartext, to any
 * diagnostic surface. {@link CREDENTIAL_FIELDS} is derived from the standard
 * requirement-family table used by {@link scopeContext}, and drift tests guard
 * its redaction coverage. The taxonomy itself comes from the binding-invoker
 * interface's context table and confidentiality clause. Flat credential
 * fields redact to "[REDACTED]"; nested credential fields retain their
 * identifiers (basic keeps its username, apiKeys keeps its scheme names) and
 * redact the known secret values. (Store KEYS are the one surface this cannot
 * reach — see {@link normalizeContextKey}, which strips userinfo so no secret
 * rides into a key.)
 */
export function redactContext(ctx: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!ctx) return null;
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (!CREDENTIAL_FIELDS.has(k)) {
      // Unknown fields pass through because this generic helper cannot infer
      // their structure. Callers must additionally redact fields their
      // binding or application classifies as sensitive.
      redacted[k] = v;
    } else if (k === "basic") {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const b = v as Record<string, unknown>;
        redacted[k] = { ...b, ...("password" in b ? { password: "[REDACTED]" } : {}) };
      } else {
        redacted[k] = "[REDACTED]";
      }
    } else if (k === "apiKeys" || k === "credentials") {
      // Scheme-scoped API keys: every named entry is credential material,
      // same as the single 'apiKey' field. Scheme names stay; values redact.
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const m = v as Record<string, unknown>;
        const rc: Record<string, unknown> = {};
        for (const name of Object.keys(m)) rc[name] = "[REDACTED]";
        redacted[k] = rc;
      } else {
        redacted[k] = "[REDACTED]";
      }
    } else {
      // Flat credential fields: bearerToken, apiKey, accessToken,
      // refreshToken, clientSecret.
      redacted[k] = "[REDACTED]";
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
 * https://, and per-path variations, share credentials for the same origin.
 * The host is lowercased and any userinfo (user[:password]@) is stripped: DNS
 * hosts are case-insensitive and userinfo is not part of a host (RFC 3986
 * §3.2.2/§6.2.2.1), and a secret in a store key is the one confidentiality
 * leak {@link redactContext} cannot reach. When the input carries a scheme,
 * an explicit port matching that scheme's default (443 for https/wss, 80 for
 * http/ws) is elided, so a key written with the default port and one written
 * without it collide; any other explicit port is kept as-is. Strings without
 * a scheme (e.g. a gRPC "host:port" format-defined address) are returned
 * as-is: with no scheme there is no known default, and eliding a port there
 * would corrupt a format-defined address.
 *
 * The keying rule (normalize to the host — lowercased, userinfo excluded) is
 * owned by the binding-invoker interface's context table; this is its
 * implementation, shared with {@link normalizeEndpoint} (the read path) so
 * write and read derive identical keys, and pinned byte-for-byte to the Go
 * SDK's NormalizeContextKey.
 */
export function normalizeContextKey(raw: string): string {
  raw = raw.trim();
  if (!raw) return raw;

  // Strip scheme — the context key is just host[:port].
  // Protocol is irrelevant to origin identity.
  const protoIdx = raw.indexOf("://");
  if (protoIdx < 0) return raw;

  const scheme = raw.slice(0, protoIdx);
  let host = raw.slice(protoIdx + 3);

  // Strip query, fragment, and path.
  const qIdx = host.indexOf("?");
  if (qIdx >= 0) host = host.slice(0, qIdx);
  const hIdx = host.indexOf("#");
  if (hIdx >= 0) host = host.slice(0, hIdx);
  const slashIdx = host.indexOf("/");
  if (slashIdx >= 0) host = host.slice(0, slashIdx);

  // Strip userinfo (user[:password]@): not part of a host, and a password
  // must never ride into a store key. At most one '@' in a conformant
  // authority.
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);

  // Case-fold the host: DNS hostnames are case-insensitive, so
  // API.example.com and api.example.com are one origin and derive one key.
  // The port is numeric, so lowercasing the whole authority leaves it
  // unchanged; an IPv6 literal folds to its canonical lowercase form.
  host = host.toLowerCase();

  return elideDefaultPort(scheme, host);
}

/**
 * Strips an explicit port from host when it equals the given scheme's
 * default port (443 for https/wss, 80 for http/ws), so a context key written
 * with the default port and one written without it resolve to the same key.
 * Any other explicit port, and any scheme with no known default, is returned
 * unchanged. The scheme is lowercased for the comparison only; it is never
 * part of the returned key.
 */
function elideDefaultPort(scheme: string, host: string): string {
  switch (scheme.toLowerCase()) {
    case "https":
    case "wss":
      return host.endsWith(":443") ? host.slice(0, -":443".length) : host;
    case "http":
    case "ws":
      return host.endsWith(":80") ? host.slice(0, -":80".length) : host;
    default:
      return host;
  }
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
 *
 * An {@link contextAnonymous} invocation derives no `Authorization` header at
 * all — that is the point of asserting it: the caller is asking for the
 * request a client with no credentials would send. Deriving one anyway would
 * let a credential left in context from an earlier call ride along, so the
 * assertion has to reach the wire and not only the negotiation. Explicit
 * `headers` and `cookies` are still merged: those are carriage the caller
 * placed by hand, not credentials this helper derived.
 */
export function buildAuthHeaders(ctx: Record<string, unknown> | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!ctx) return headers;

  if (!contextAnonymous(ctx)) {
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
  }
  for (const [k, v] of Object.entries(contextHeaders(ctx))) {
    headers[k] = v;
  }
  const pairs = Object.entries(contextCookies(ctx)).map(([k, v]) => `${k}=${v}`).sort();
  if (pairs.length > 0) headers["Cookie"] = pairs.join("; ");
  return headers;
}

/**
 * Normalizes a remote endpoint URL to a context store key. Parses the URL
 * and returns `normalizeContextKey("scheme://host[:port]")` (so a port
 * matching the scheme's default is elided, same as `normalizeContextKey`);
 * falls back to `normalizeContextKey(url)` for non-URL strings.
 */
export function normalizeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    if (!u.host) return normalizeContextKey(url);
    return normalizeContextKey(`${u.protocol.replace(/:$/, "")}://${u.host}`);
  } catch {
    return normalizeContextKey(url);
  }
}

// ---------------------------------------------------------------------------
// Store-backed context resolver
// ---------------------------------------------------------------------------

/**
 * True when one requirement is satisfied by the stored context. Every family
 * but `auth.apiKey` gates on the presence of its single well-known field
 * (REQUIREMENT_FIELDS); `auth.apiKey` is name-aware — a requirement carrying
 * a `name` (two ANDed API keys are otherwise indistinguishable) is satisfied
 * by that name's entry in `apiKeys`, falling back to the single `apiKey`
 * convenience, via the same precedence {@link contextApiKeyFor} uses for
 * credential application. An unrecognized `type` falls back to looking up a
 * field of that same name, which stored context never carries, so it is
 * always unsatisfiable (an invoker surfaces such a requirement so its
 * alternative is discoverable, never so it becomes selectable at this
 * layer — rule 10 of the binding-invoker interface: no resolver here, no
 * invented satisfaction convention).
 */
function requirementSatisfied(
  ctx: Record<string, unknown>,
  req: ContextRequirement,
  allowFlatNamedCredential = true,
): boolean {
  // Anonymity answers credential requirements and nothing else. A
  // `config.value` point — which server to talk to, which request media to
  // send — is not a credential and has no anonymous reading, so an alternative
  // mixing the two still has to answer the configuration half.
  if (contextAnonymous(ctx) && req.type.startsWith("auth.")) return true;
  const name = typeof req.name === "string" && req.name ? req.name : undefined;
  const named = contextNamedCredential(ctx, name);
  if (req.type === "auth.bearer") {
    if (typeof named === "string" && named) return true;
    return allowFlatNamedCredential && contextBearerToken(ctx) !== "";
  }
  if (req.type === "auth.apiKey") {
    if (typeof named === "string" && named) return true;
    const legacyNamed = name ? contextApiKeys(ctx)[name] : undefined;
    if (legacyNamed) return true;
    return allowFlatNamedCredential && contextApiKey(ctx) !== "";
  }
  if (req.type === "auth.basic") {
    if (name && named && typeof named === "object" && !Array.isArray(named)) {
      const value = named as Record<string, unknown>;
      const username = value["username"];
      const password = value["password"];
      if (typeof username === "string" && typeof password === "string" && (username !== "" || password !== "")) return true;
    }
    return allowFlatNamedCredential && contextBasicAuth(ctx) !== null;
  }
  if (req.type === "auth.oauth2") {
    if (name && named && typeof named === "object" && !Array.isArray(named)) {
      const token = (named as Record<string, unknown>)["accessToken"];
      if (typeof token === "string" && token) return true;
    }
    if (!allowFlatNamedCredential) return false;
    // A flat bearer token counts here because an OAuth2 access token reaches
    // the wire AS a Bearer credential, and the placement side already knows it:
    // credential application falls back to the flat bearer token when no
    // accessToken is present. Until these two agreed, an artifact declaring
    // oauth2 was a dead end — the challenge asked for context, the remedy it
    // printed stored a bearerToken, and the next attempt challenged
    // identically because only `accessToken` counted. OAuth2 is among the most
    // common schemes in real documents, so that disagreement closed off a
    // large share of them.
    return contextString(ctx, "accessToken") !== "" || contextBearerToken(ctx) !== "";
  }
  if (req.type === "config.value") {
    const point = typeof req.point === "string" ? req.point : "";
    const path = typeof req.path === "string" ? req.path : "";
    const configuration = ctx["configuration"];
    if (
      !point
      || !configuration
      || typeof configuration !== "object"
      || Array.isArray(configuration)
    ) {
      return false;
    }
    const selected = configurationValueAt(
      (configuration as Record<string, unknown>)[point],
      path,
    );
    return selected.present
      && selected.value !== undefined
      && selected.value !== null
      && selected.value !== "";
  }
  const mappedField = REQUIREMENT_FIELDS[req.type];
  if (mappedField === undefined && req.type.startsWith("auth.")) {
    return false;
  }
  const field = mappedField ?? req.type;
  const v = ctx[field];
  return v !== undefined && v !== null && v !== "";
}

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
  return details.alternatives.some((alt) => {
    if (alt.requirements.length === 0) return false;
    return alt.requirements.every((req) => {
      return requirementSatisfied(ctx, req, flatCredentialIsUnambiguous(details, req));
    });
  });
}

function flatCredentialIsUnambiguous(
  details: ContextRequiredDetails,
  requirement: ContextRequirement,
): boolean {
  const identities = new Set<string>();
  let unnamed = 0;
  for (const alternative of details.alternatives) {
    for (const candidate of alternative.requirements) {
      if (candidate.type !== requirement.type) continue;
      if (typeof candidate.name === "string" && candidate.name) identities.add(candidate.name);
      else unnamed++;
    }
  }
  return identities.size + unnamed === 1;
}

/**
 * Maps a requirement family to every context field that belongs to it.
 * REQUIREMENT_FIELDS names only the field whose presence gates satisfaction;
 * this names the whole family so scoping can admit (for example) an oauth2
 * refresh token alongside its access token. Fields outside the selected
 * requirement family are not admitted: this helper cannot infer whether an
 * arbitrary header, cookie, environment value, metadata entry, or
 * configuration point is sensitive. `auth.apiKey` lists both `apiKey`
 * and `apiKeys`; scopeContext admits
 * `apiKeys` narrowed to the selected alternative's named entries only (never
 * the whole map — see admitApiKey), so this list is not used to copy it
 * verbatim the way it is for every other family.
 */
const REQUIREMENT_FAMILY_FIELDS: Record<string, string[]> = {
  "auth.bearer": ["bearerToken"],
  "auth.apiKey": ["apiKey", "apiKeys"],
  "auth.basic": ["basic"],
  // `bearerToken` belongs here because requirementSatisfied's oauth2 arm
  // accepts one. Without it the two rules in this file contradicted each
  // other: the challenge validated against a stored bearer token and then
  // scopeContext admitted nothing, so a caller supplied exactly what the
  // error asked for, the scope gate dropped it, and the invoker re-challenged
  // forever. A rule that says a value satisfies a requirement has to let that
  // value through. Twin of openbindings-go/contextstore.go.
  "auth.oauth2": ["accessToken", "bearerToken", "refreshToken", "clientSecret"],
};

/**
 * The set of context fields the credential taxonomy always classifies as secret,
 * derived from REQUIREMENT_FAMILY_FIELDS so the standard requirement-family
 * and redaction registries evolve together. Exported for the drift-guard test
 * that asserts redaction covers every registered field. Other fields may also
 * be sensitive according to their binding specification or application
 * meaning.
 */
export const CREDENTIAL_FIELDS = new Set([
  ...Object.values(REQUIREMENT_FAMILY_FIELDS).flat(),
  "credentials",
]);

/**
 * Admits the API key credential for one `auth.apiKey` requirement into the
 * scoped output, least-privilege: a named requirement admits only that
 * name's entry from `stored.apiKeys` (merged into `out.apiKeys`, never the
 * whole map), falling back to the flat `stored.apiKey` when the requirement
 * carries no `name` or the map lacks that entry — mirrors
 * {@link contextApiKeyFor}'s read precedence, applied to scoping instead of
 * a single read.
 */
function admitApiKey(
  stored: Record<string, unknown>,
  out: Record<string, unknown>,
  name: string | undefined,
): void {
  if (name) {
    const credentials = stored["credentials"];
    if (credentials && typeof credentials === "object" && !Array.isArray(credentials)) {
      const value = (credentials as Record<string, unknown>)[name];
      if (typeof value === "string" && value) {
        const existing = (out["credentials"] as Record<string, unknown> | undefined) ?? {};
        out["credentials"] = { ...existing, [name]: value };
        return;
      }
    }
    const map = stored["apiKeys"];
    if (map && typeof map === "object" && !Array.isArray(map) && name in (map as Record<string, unknown>)) {
      const existing = (out["apiKeys"] as Record<string, unknown> | undefined) ?? {};
      out["apiKeys"] = { ...existing, [name]: (map as Record<string, unknown>)[name] };
      return;
    }
  }
  if ("apiKey" in stored) out["apiKey"] = stored["apiKey"];
}

/**
 * Returns the least-privilege subset of a stored context for a challenge
 * (binding-invoker interface). A CONTEXT_REQUIRED challenge is a scope, not a hint:
 * the invoker receives only what the first satisfied alternative declares.
 * Standard credential requirements admit their corresponding family;
 * `config.value` admits only its named configuration point; an extension
 * requirement admits its type-named field. No other stored field passes by
 * default because this generic helper cannot determine its sensitivity or
 * relevance. With no challenge there is nothing to scope, so the full context
 * is returned (copied).
 */
export function scopeContext(
  stored: Record<string, unknown>,
  details: ContextRequiredDetails | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!details) {
    for (const [k, v] of Object.entries(stored)) {
      out[k] = v;
    }
    return out;
  }
  for (const alt of details.alternatives) {
    if (alt.requirements.length === 0) continue;
    const satisfied = alt.requirements.every((req) => {
      return requirementSatisfied(stored, req, flatCredentialIsUnambiguous(details, req));
    });
    if (!satisfied) continue;
    for (const req of alt.requirements) {
      if (req.type === "auth.apiKey") {
        admitApiKey(stored, out, typeof req.name === "string" ? req.name : undefined);
        continue;
      }
      if (req.type === "config.value") {
        const point = typeof req.point === "string" ? req.point : "";
        const path = typeof req.path === "string" ? req.path : "";
        const configuration = stored["configuration"];
        if (
          point
          && configuration
          && typeof configuration === "object"
          && !Array.isArray(configuration)
          && point in configuration
        ) {
          const existing =
            out["configuration"]
            && typeof out["configuration"] === "object"
            && !Array.isArray(out["configuration"])
              ? out["configuration"] as Record<string, unknown>
              : {};
          const pointValue = (configuration as Record<string, unknown>)[point];
          const selected = configurationValueAt(pointValue, path);
          if (!selected.present) continue;
          if (path === "") {
            out["configuration"] = { ...existing, [point]: pointValue };
          } else {
            const priorPoint = existing[point];
            const scopedPoint = priorPoint && typeof priorPoint === "object" && !Array.isArray(priorPoint)
              ? priorPoint as Record<string, unknown>
              : {};
            out["configuration"] = {
              ...existing,
              [point]: mergeConfigurationFragment(
                scopedPoint,
                configurationFragment(path, selected.value),
              ),
            };
          }
        }
        continue;
      }
      const name = typeof req.name === "string" && req.name ? req.name : undefined;
      if (name && req.type.startsWith("auth.")) {
        const credentials = stored["credentials"];
        if (credentials && typeof credentials === "object" && !Array.isArray(credentials) && name in credentials) {
          const existing = (out["credentials"] as Record<string, unknown> | undefined) ?? {};
          out["credentials"] = { ...existing, [name]: (credentials as Record<string, unknown>)[name] };
          continue;
        }
      }
      const fields = REQUIREMENT_FAMILY_FIELDS[req.type] ?? [req.type];
      for (const f of fields) {
        if (f in stored) out[f] = stored[f];
      }
    }
    return out;
  }
  return out;
}

function configurationPointerTokens(path: string): string[] | null {
  if (path === "") return [];
  if (!path.startsWith("/")) return null;
  const tokens = path.slice(1).split("/");
  if (tokens.some((token) => /(?:~(?![01]))/.test(token))) return null;
  return tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function configurationValueAt(
  root: unknown,
  path: string,
): { present: boolean; value?: unknown } {
  const tokens = configurationPointerTokens(path);
  if (tokens === null) return { present: false };
  let current = root;
  if (tokens.length === 0) return { present: root !== undefined, value: root };
  for (const token of tokens) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, token)) {
      return { present: false };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { present: true, value: current };
}

function configurationFragment(path: string, value: unknown): Record<string, unknown> {
  const tokens = configurationPointerTokens(path) ?? [];
  let fragment: unknown = value;
  for (let index = tokens.length - 1; index >= 0; index--) {
    fragment = { [tokens[index]!]: fragment };
  }
  return fragment as Record<string, unknown>;
}

function mergeConfigurationFragment(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const prior = out[key];
    out[key] = prior && value
      && typeof prior === "object" && !Array.isArray(prior)
      && typeof value === "object" && !Array.isArray(value)
      ? mergeConfigurationFragment(
          prior as Record<string, unknown>,
          value as Record<string, unknown>,
        )
      : value;
  }
  return out;
}

/**
 * Builds a read-only {@link ContextResolver} backed by a {@link ContextStore}:
 * an optional stored realization of binding-invoker challenges. It derives
 * the store key from the challenge's `target` by normalizing it
 * ({@link normalizeEndpoint}), returns the least-privilege subset of the stored
 * context ({@link scopeContext}) when it satisfies one of the challenge's
 * alternatives, and declines (null) otherwise — at which point the challenge
 * surfaces to the caller unchanged. A CONTEXT_REQUIRED challenge is a scope,
 * not a hint: only context fields named by the satisfied alternative are
 * returned. Arbitrary stored fields are not classified or forwarded.
 *
 * A stored entry that does NOT satisfy the challenge (wrong field name, empty
 * value) is a decline like any other: the challenge surfaces, and the
 * {@link InvocationError} data retains the structured requirement.
 *
 * This generic helper treats the co-located invoker that produced `target` as
 * inside the application's trust boundary. Do not use it unchanged for an
 * untrusted remote/delegate assertion: validate that target independently
 * before this resolver can release reusable stored secrets.
 *
 * Apps that resolve interactively (prompt, browser redirect, keychain)
 * supply their own resolver and MAY persist what they obtain for
 * `durable: true` requirements under an application-chosen key; non-durable
 * context MUST NOT be persisted.
 */
export function storeContextResolver(store: ContextStore): ContextResolver {
  return async (details: ContextRequiredDetails) => {
    // Stored context is reusable only where every member of a complete
    // alternative explicitly opts into reuse. Durability defaults to false;
    // filtering individual members of an AND-set would weaken the challenge.
    const reusable: ContextRequiredDetails = {
      ...details,
      alternatives: details.alternatives.filter(
        (alternative) =>
          alternative.requirements.length > 0 &&
          alternative.requirements.every(
            (requirement) => requirement.durable === true,
          ),
      ),
    };
    if (reusable.alternatives.length === 0) return null;
    const key = normalizeEndpoint(details.target);
    // An empty or unkeyable target cannot safely select reusable stored
    // context. Interactive or application-specific resolvers may still
    // satisfy the challenge.
    if (!key) return null;
    const ctx = await store.get(key);
    if (!ctx) return null;
    return contextSatisfies(ctx, reusable) ? scopeContext(ctx, reusable) : null;
  };
}
