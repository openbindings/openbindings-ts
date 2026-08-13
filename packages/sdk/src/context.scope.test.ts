import { describe, expect, it } from "vitest";
import { scopeContext } from "./context.js";
import type { ContextRequiredDetails } from "./invocation.js";

// scopeContext enforces least privilege: a CONTEXT_REQUIRED challenge is a
// scope, not a hint. Only fields named by the satisfied alternative pass;
// arbitrary stored context is not assumed public or relevant.
describe("scopeContext", () => {
  it("withholds unrelated credentials and unrequested context", () => {
    const stored = {
      bearerToken: "tok",
      apiKey: "key", // unrelated credential, must be withheld
      headers: { Accept: "application/json" },
    };
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    };
    expect(scopeContext(stored, details)).toEqual({ bearerToken: "tok" });
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
    });
    expect("apiKey" in got).toBe(false);
    expect("headers" in got).toBe(false);
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
    expect(scopeContext(stored, details)).toEqual({ apiKeys: { headerKey: "k1" } });
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

  it("admits only selected entries from the general named credential map", () => {
    const stored = {
      credentials: {
        bearer: "token",
        basic: { username: "u", password: "p" },
        unrelated: "secret",
      },
    };
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [{ requirements: [
        { type: "auth.bearer", name: "bearer" },
        { type: "auth.basic", name: "basic" },
      ] }],
    };
    expect(scopeContext(stored, details)).toEqual({
      credentials: {
        bearer: "token",
        basic: { username: "u", password: "p" },
      },
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

  it("admits only the config.value point named by the requirement", () => {
    const stored = {
      configuration: {
        server: { url: "https://api.example.com" },
        decode: "text",
      },
      headers: { Authorization: "sensitive" },
    };
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [{
        requirements: [{ type: "config.value", point: "server", path: "/url" }],
      }],
    };
    expect(scopeContext(stored, details)).toEqual({
      configuration: { server: { url: "https://api.example.com" } },
    });
  });

  it("admits a whole config.value point when path is empty", () => {
    const stored = {
      configuration: { address: "orders/{id}", decode: "json" },
    };
    const details: ContextRequiredDetails = {
      target: "x",
      alternatives: [{ requirements: [
        { type: "config.value", point: "address", path: "" },
      ] }],
    };
    expect(scopeContext(stored, details)).toEqual({
      configuration: { address: "orders/{id}" },
    });
  });
});
