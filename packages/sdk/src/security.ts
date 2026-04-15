import type { SecurityMethod } from "./types.js";
import type { PlatformCallbacks, BrowserRedirectResult } from "./context.js";

/** Thrown by platform callbacks to signal the user cancelled the prompt.
 *  Implementations should throw this (or set `name` to `"AuthCancelled"`)
 *  to abort the entire security resolution loop immediately. */
function isAuthCancelled(e: unknown): boolean {
  if (e instanceof Error && (e.name === "AuthCancelled" || e.name === "AuthCancelledError")) return true;
  return false;
}

/**
 * Walks the given security methods in preference order and uses the available
 * platform callbacks to interactively acquire credentials. Returns the acquired
 * credentials as a context record (using well-known field names: bearerToken,
 * apiKey, basic), or null if no method could be resolved.
 *
 * This is a utility function that can be called at any time -- on auth error,
 * proactively before execution, from a CLI login command, or from any code
 * that needs credentials for a set of security methods.
 *
 * Unknown method types are skipped. If no method can be resolved (because the
 * required callbacks are unavailable or the user provides no value), returns null.
 */
export async function resolveSecurity(
  methods: SecurityMethod[],
  callbacks: PlatformCallbacks,
  fetchFn?: typeof globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  if (!methods.length || !callbacks) return null;

  for (const method of methods) {
    const creds = await resolveMethod(method, callbacks, fetchFn);
    if (creds) return creds;
  }

  return null;
}

async function resolveMethod(
  method: SecurityMethod,
  callbacks: PlatformCallbacks,
  fetchFn?: typeof globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  switch (method.type) {
    case "bearer":
      return resolveBearerMethod(method, callbacks);
    case "oauth2":
      return resolveOAuth2Method(method, callbacks, fetchFn);
    case "basic":
      return resolveBasicMethod(method, callbacks);
    case "apiKey":
      return resolveAPIKeyMethod(method, callbacks);
    default:
      return null; // unknown type, skip
  }
}

async function resolveBearerMethod(
  method: SecurityMethod,
  callbacks: PlatformCallbacks,
): Promise<Record<string, unknown> | null> {
  if (!callbacks.prompt) return null;

  const desc = method.description || "Enter bearer token";
  let value: string;
  try {
    value = await callbacks.prompt(desc, { label: "bearerToken", secret: true });
  } catch (e) {
    if (isAuthCancelled(e)) throw e;
    return null;
  }
  if (!value) return null;

  return { bearerToken: value };
}

async function resolveOAuth2Method(
  method: SecurityMethod,
  callbacks: PlatformCallbacks,
  fetchFn?: typeof globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  // Try BrowserRedirect for the full PKCE flow
  if (callbacks.browserRedirect && method.authorizeUrl && method.tokenUrl) {
    try {
      const token = await performPKCEFlow(method, callbacks.browserRedirect, fetchFn);
      return { bearerToken: token };
    } catch {
      // Fall through to prompt if PKCE fails
    }
  }

  // Fallback: prompt for bearer token
  if (!callbacks.prompt) return null;
  const desc = method.description || "Enter OAuth2 bearer token";
  let value: string;
  try {
    value = await callbacks.prompt(desc, { label: "bearerToken", secret: true });
  } catch (e) {
    if (isAuthCancelled(e)) throw e;
    return null;
  }
  if (!value) return null;
  return { bearerToken: value };
}

async function performPKCEFlow(
  method: SecurityMethod,
  browserRedirect: (url: string) => Promise<BrowserRedirectResult>,
  fetchFn?: typeof globalThis.fetch,
): Promise<string> {
  // 1. Generate code verifier (32 random bytes, base64url encoded)
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64UrlEncode(verifierBytes);

  // 2. Generate code challenge (SHA256 of verifier, base64url encoded)
  const challengeBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(challengeBuffer));

  // 3. Generate state for CSRF protection
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = base64UrlEncode(stateBytes);

  // 4. Build authorization URL
  const authURL = new URL(method.authorizeUrl!);
  authURL.searchParams.set("response_type", "code");
  authURL.searchParams.set("code_challenge", codeChallenge);
  authURL.searchParams.set("code_challenge_method", "S256");
  authURL.searchParams.set("state", state);
  if (method.clientId) {
    authURL.searchParams.set("client_id", method.clientId);
  }
  if (method.scopes?.length) {
    authURL.searchParams.set("scope", method.scopes.join(" "));
  }

  // 5. Call BrowserRedirect
  const result = await browserRedirect(authURL.toString());

  // 6. Verify state before extracting code (CSRF protection first)
  const callbackURL = new URL(result.callbackURL);
  const callbackState = callbackURL.searchParams.get("state");
  if (callbackState !== state) {
    throw new Error("state mismatch in OAuth2 callback (CSRF protection)");
  }

  // 7. Parse authorization code from callback URL
  const code = callbackURL.searchParams.get("code");
  if (!code) {
    const error = callbackURL.searchParams.get("error");
    const errorDesc = callbackURL.searchParams.get("error_description");
    if (error) {
      throw new Error(`authorization denied: ${error}${errorDesc ? `: ${errorDesc}` : ""}`);
    }
    throw new Error("no authorization code in callback URL");
  }

  // 8. Exchange code for token
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
  });
  if (method.clientId) {
    tokenParams.set("client_id", method.clientId);
  }
  if (result.redirectUri) {
    tokenParams.set("redirect_uri", result.redirectUri);
  }

  const doFetch = fetchFn ?? globalThis.fetch;
  const tokenResp = await doFetch(method.tokenUrl!, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: tokenParams.toString(),
  });

  const body = await tokenResp.text();
  if (!tokenResp.ok) {
    throw new Error(`token exchange failed: HTTP ${tokenResp.status}: ${body}`);
  }

  const tokenResult = JSON.parse(body) as {
    access_token?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenResult.error) {
    throw new Error(`token exchange error: ${tokenResult.error}: ${tokenResult.error_description ?? ""}`);
  }
  if (!tokenResult.access_token) {
    throw new Error("no access_token in token response");
  }

  return tokenResult.access_token;
}

/** Base64url encode without padding. */
function base64UrlEncode(bytes: Uint8Array): string {
  // Use btoa for base64, then convert to base64url
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function resolveBasicMethod(
  method: SecurityMethod,
  callbacks: PlatformCallbacks,
): Promise<Record<string, unknown> | null> {
  if (!callbacks.prompt) return null;

  let username: string;
  let password: string;
  try {
    username = await callbacks.prompt("Enter username", { label: "username" });
    password = await callbacks.prompt("Enter password", {
      label: "password",
      secret: true,
    });
  } catch (e) {
    if (isAuthCancelled(e)) throw e;
    return null;
  }

  return { basic: { username, password } };
}

async function resolveAPIKeyMethod(
  method: SecurityMethod,
  callbacks: PlatformCallbacks,
): Promise<Record<string, unknown> | null> {
  if (!callbacks.prompt) return null;

  const desc = method.description || "Enter API key";
  let value: string;
  try {
    value = await callbacks.prompt(desc, { label: "apiKey", secret: true });
  } catch (e) {
    if (isAuthCancelled(e)) throw e;
    return null;
  }
  if (!value) return null;

  return { apiKey: value };
}
