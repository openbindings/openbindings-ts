/**
 * redactContext tests — the context-confidentiality invariant on the value
 * surface. TS shipped no redact test, which is exactly why the scheme-scoped
 * `apiKeys` leak went unnoticed; this file pins it and mirrors the Go SDK's
 * TestRedactContext / TestRedactContext_CoversEveryCredentialField.
 */
import { describe, it, expect } from "vitest";
// CREDENTIAL_FIELDS is the single credential registry (imported from the
// internal module, not the public barrel) so the drift guard iterates every
// standard credential field derived from the scoping family table.
import { redactContext, CREDENTIAL_FIELDS } from "./context.js";

describe("redactContext", () => {
  it("redacts flat, scheme-scoped, and basic credentials; keeps unclassified values", () => {
    const red = redactContext({
      bearerToken: "secret",
      apiKey: "flat-secret",
      apiKeys: { stripe: "sk_live_SECRET" },
      basic: { username: "u", password: "pw" },
      plain: "visible",
    })!;
    expect(red.bearerToken).toBe("[REDACTED]");
    expect(red.apiKey).toBe("[REDACTED]");
    // Scheme-scoped apiKeys: value scrubbed, scheme name kept (the leak M1).
    expect((red.apiKeys as Record<string, unknown>).stripe).toBe("[REDACTED]");
    expect((red.basic as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((red.basic as Record<string, unknown>).username).toBe("u");
    expect(red.plain).toBe("visible");
  });

  it("returns null for null/undefined input", () => {
    expect(redactContext(null)).toBeNull();
    expect(redactContext(undefined)).toBeNull();
  });

  // The drift guard whose absence let the apiKeys leak ship: for EVERY field
  // the credential registry classifies as secret, place a distinctive
  // sentinel in that field's proper shape, redact, serialize, and assert the
  // sentinel appears NOWHERE. Adding a credential family to the registry
  // without teaching redactContext its shape fails this automatically.
  it("covers every credential field: no sentinel survives redaction", () => {
    const shaped = (field: string, sentinel: string): unknown => {
      switch (field) {
        case "basic":
          return { username: "visible-user", password: sentinel };
        case "apiKeys":
        case "credentials":
          return { stripe: sentinel, twilio: sentinel + "-b" };
        default:
          return sentinel;
      }
    };
    for (const field of CREDENTIAL_FIELDS) {
      const sentinel = `SENTINEL_${field}_9f3ac1`;
      const out = JSON.stringify(redactContext({ [field]: shaped(field, sentinel), plainCfg: "keepme" }));
      expect(out, `redactContext leaked a ${field} secret`).not.toContain(sentinel);
      expect(out, `redactContext dropped an unclassified pass-through value for ${field}`).toContain("keepme");
    }
  });

  it("keeps structural identifiers of nested credential fields", () => {
    const red = redactContext({
      apiKeys: { stripe: "sk" },
      basic: { username: "alice", password: "pw" },
    })!;
    // Scheme names and basic username survive; only the values are scrubbed.
    expect(Object.keys(red.apiKeys as Record<string, unknown>)).toContain("stripe");
    expect((red.basic as Record<string, unknown>).username).toBe("alice");
  });
});
