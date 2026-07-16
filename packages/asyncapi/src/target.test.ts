import { describe, expect, it } from "vitest";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { resolveTarget } from "./target.js";

// Unit coverage for resolveTarget's default selection and the legacy
// metadata.baseURL override (ASYNC-P-04, §9.5). Mirrors the Go SDK's
// TestResolveTarget_* in util_test.go; the full configuration-point matrix
// is exercised end to end in conformance.test.ts.

function doc(): AsyncAPIDocument {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    servers: {
      prod: { host: "api.example.com", protocol: "https" },
    },
  };
}

describe("resolveTarget", () => {
  it("assembles the default server and carries it as the security server", () => {
    const d = doc();
    const target = resolveTarget(d, undefined, undefined);
    expect(target.protocol).toBe("https");
    expect(target.serverURL).toBe("https://api.example.com");
    expect(target.securityServer).toBe(d.servers!.prod);
  });

  it("honors the legacy metadata.baseURL override below the configuration point, keeping the default-selected server's security", () => {
    const d = doc();
    const target = resolveTarget(d, undefined, {
      metadata: { baseURL: "http://localhost:8080" },
    });
    expect(target.protocol).toBe("http");
    expect(target.serverURL).toBe("http://localhost:8080");
    // Under a full-URL override the declared security of the server the
    // default selection would have targeted still applies (§9.5).
    expect(target.securityServer).toBe(d.servers!.prod);
  });

  it("refuses when the document declares no servers", () => {
    const empty: AsyncAPIDocument = { asyncapi: "3.0.0", info: { title: "t", version: "1" } };
    expect(() => resolveTarget(empty, undefined, undefined)).toThrow(/no resolvable server/);
  });
});
