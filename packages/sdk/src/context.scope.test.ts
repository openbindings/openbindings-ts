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

  // R2.e ruling: apiKeys passes through scoped to the NAMES the selected
  // alternative's apiKey requirements carry, never the whole map — a store
  // holding entries for two names and a challenge naming only one must leak
  // only that one entry.
  it("admits only the named apiKeys entries the selected alternative requires", () => {
    const stored = {
      apiKeys: { headerKey: "k1", queryKey: "k2", unrelated: "k3" },
      headers: { Accept: "application/json" },
    };
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [{ requirements: [{ type: "auth.apiKey", name: "headerKey" }] }],
    };
    expect(scopeContext(stored, details)).toEqual({
      apiKeys: { headerKey: "k1" },
      headers: { Accept: "application/json" },
    });
  });

  it("admits every named entry an AND of apiKey requirements needs, and no other", () => {
    const stored = {
      apiKeys: { headerKey: "k1", queryKey: "k2", unrelated: "k3" },
    };
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [
        {
          requirements: [
            { type: "auth.apiKey", name: "headerKey" },
            { type: "auth.apiKey", name: "queryKey" },
          ],
        },
      ],
    };
    expect(scopeContext(stored, details)).toEqual({
      apiKeys: { headerKey: "k1", queryKey: "k2" },
    });
  });

  it("falls back to the flat apiKey when the requirement carries no name", () => {
    const stored = { apiKeys: { headerKey: "k1" }, apiKey: "flat" };
    const details: ContextRequiredDetails = {
      target: "x",
      alternatives: [{ requirements: [{ type: "auth.apiKey" }] }],
    };
    expect(scopeContext(stored, details)).toEqual({ apiKey: "flat" });
  });
});
