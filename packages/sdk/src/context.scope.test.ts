import { describe, expect, it } from "vitest";
import { scopeContext } from "./context.js";
import type { ContextRequiredDetails } from "./invocation.js";

// scopeContext enforces least privilege: a CONTEXT_REQUIRED challenge is a
// scope, not a hint. Non-secret config always passes; only the satisfied
// alternative's credential family is admitted; other credentials are withheld.
describe("scopeContext", () => {
  it("withholds unrelated credentials, keeps non-secret config", () => {
    const stored = {
      bearerToken: "tok",
      apiKey: "key", // unrelated credential, must be withheld
      headers: { Accept: "application/json" },
    };
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    };
    expect(scopeContext(stored, details)).toEqual({
      bearerToken: "tok",
      headers: { Accept: "application/json" },
    });
  });

  it("admits the whole oauth2 family but no other credential", () => {
    const stored = {
      accessToken: "at",
      refreshToken: "rt",
      clientSecret: "cs",
      apiKey: "key", // unrelated, must be withheld
      headers: { X: "1" },
    };
    const details: ContextRequiredDetails = {
      target: "x",
      alternatives: [{ requirements: [{ type: "auth.oauth2" }] }],
    };
    const got = scopeContext(stored, details);
    expect(got).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      clientSecret: "cs",
      headers: { X: "1" },
    });
    expect("apiKey" in got).toBe(false);
  });

  it("returns an independent copy when there is no challenge", () => {
    const stored = { bearerToken: "tok", headers: { A: "b" } };
    const got = scopeContext(stored, null);
    expect(got).toEqual(stored);
    got["injected"] = "x";
    expect("injected" in stored).toBe(false);
  });
});
