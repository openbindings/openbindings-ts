import { describe, it, expect } from "vitest";
import { resolveServer } from "./servers.js";
import type { OpenAPIDocument } from "./types.js";

// Mirrors Go's servers_test.go: §10 (OAPI-P-04) server resolution — the
// effective list, variable substitution, the configuration point, relative
// resolution against the declaring document, and the pre-dispatch refusal.

function serversDoc(): OpenAPIDocument {
  return {
    openapi: "3.0.3",
    servers: [{ url: "https://doc-a.example.com" }, { url: "https://doc-b.example.com" }],
  };
}

function ctxWith(server: unknown): Record<string, unknown> {
  return { configuration: { server } };
}

// OAPI-P-05: the effective server list is operation servers, else path-item
// servers, else document servers, else the implied "/".
describe("resolveServer — effective list precedence", () => {
  const doc = serversDoc();
  const pathItem = { servers: [{ url: "https://path.example.com" }] };
  const op = { servers: [{ url: "https://op.example.com" }] };

  it("operation servers win", () => {
    expect(resolveServer(doc, pathItem, op, undefined, "")).toBe("https://op.example.com");
  });

  it("path-item servers next", () => {
    expect(resolveServer(doc, pathItem, {}, undefined, "")).toBe("https://path.example.com");
  });

  it("preserves document-server alternatives until the consumer selects one", () => {
    expect(() => resolveServer(doc, null, {}, undefined, "")).toThrow(/2 alternatives/);
    expect(resolveServer(doc, null, {}, ctxWith({ index: 0 }), "")).toBe("https://doc-a.example.com");
    expect(resolveServer(doc, null, {}, ctxWith({ index: 1 }), "")).toBe("https://doc-b.example.com");
  });

  it("the implied / resolves against the artifact's base URI (the location)", () => {
    expect(resolveServer({}, null, null, undefined, "https://host.example.com/openapi.json")).toBe(
      "https://host.example.com/",
    );
  });
});

// The default substitutes each server variable's declared default.
describe("resolveServer — variable defaults", () => {
  it("substitutes declared defaults", () => {
    const doc: OpenAPIDocument = {
      servers: [
        {
          url: "https://{env}.example.com:{port}/v2",
          variables: {
            env: { default: "api", enum: ["api", "staging"] },
            port: { default: "8443" },
          },
        },
      ],
    };
    expect(resolveServer(doc, null, null, undefined, "")).toBe("https://api.example.com:8443/v2");
  });

  // A declared variable with no default and no supplied value is loud.
  it("refuses a variable with no supplied value and no declared default", () => {
    const doc: OpenAPIDocument = {
      servers: [{ url: "https://{host}/v1", variables: { host: {} } }],
    };
    expect(() => resolveServer(doc, null, null, undefined, "")).toThrow("host");
  });
});

// The server configuration point: entry selection by url or index, variable
// values (enum-validated), and an outright baseUrl.
describe("resolveServer — the configuration point", () => {
  const doc: OpenAPIDocument = {
    servers: [
      {
        url: "https://{env}.example.com",
        variables: { env: { default: "api", enum: ["api", "staging"] } },
      },
      { url: "https://alt.example.com/base/" },
    ],
  };

  it("accepts an outright base URL (string shorthand and object form)", () => {
    expect(resolveServer(doc, null, null, ctxWith("https://override.example.com"), "")).toBe(
      "https://override.example.com",
    );
    expect(
      resolveServer(doc, null, null, ctxWith({ baseUrl: "https://override.example.com/x" }), ""),
    ).toBe("https://override.example.com/x");
  });

  it("selects another entry by url and preserves its trailing slash", () => {
    expect(
      resolveServer(doc, null, null, ctxWith({ url: "https://alt.example.com/base/" }), ""),
    ).toBe("https://alt.example.com/base/");
  });

  it("a string matching a declared entry's url template selects that entry", () => {
    expect(resolveServer(doc, null, null, ctxWith("https://{env}.example.com"), "")).toBe(
      "https://api.example.com",
    );
  });

  it("selects by index", () => {
    expect(resolveServer(doc, null, null, ctxWith({ index: 1 }), "")).toBe(
      "https://alt.example.com/base/",
    );
  });

  it("substitutes supplied variables on the selected entry and enforces its enum", () => {
    expect(resolveServer(doc, null, null, ctxWith({ index: 0, variables: { env: "staging" } }), "")).toBe(
      "https://staging.example.com",
    );
    expect(() => resolveServer(
      doc,
      null,
      null,
      ctxWith({ index: 0, variables: { env: "prod" } }),
      "",
    )).toThrow(/outside its declared enum/);
    expect(() =>
      resolveServer(doc, null, null, ctxWith({ index: 0, variables: { nope: "x" } }), ""),
    ).toThrow('declares no variable "nope"');
  });

  it("a config that selects nothing is loud, not silently ignored", () => {
    expect(() =>
      resolveServer(doc, null, null, ctxWith({ url: "https://unknown.example.com" }), ""),
    ).toThrow("matches no declared server entry");
    expect(() => resolveServer(doc, null, null, ctxWith({ index: 9 }), "")).toThrow(
      "not a valid index",
    );
  });
});

// A relative effective-server URL resolves against its declaring document's
// location per RFC 3986; the one recoverable pre-dispatch requirement is a
// server URL that cannot resolve absolute without consumer configuration.
describe("resolveServer — relative resolution", () => {
  it("resolves a path-absolute server against the location", () => {
    const doc: OpenAPIDocument = { servers: [{ url: "/api/v3" }] };
    expect(resolveServer(doc, null, null, undefined, "https://example.com/specs/openapi.json")).toBe(
      "https://example.com/api/v3",
    );
  });

  it("refuses pre-dispatch when no base URI exists", () => {
    const doc: OpenAPIDocument = { servers: [{ url: "/api/v3" }] };
    expect(() => resolveServer(doc, null, null, undefined, "")).toThrow(
      "cannot resolve to an absolute URL",
    );
  });

  it("resolves a relative-path server per RFC 3986", () => {
    const doc: OpenAPIDocument = { servers: [{ url: "v2" }] };
    expect(resolveServer(doc, null, null, undefined, "https://example.com/specs/openapi.json")).toBe(
      "https://example.com/specs/v2",
    );
  });
});

// The legacy context.metadata.baseURL override still works, below the
// configuration point.
describe("resolveServer — legacy metadata.baseURL", () => {
  it("honors metadata.baseURL below the configuration point", () => {
    const ctx: Record<string, unknown> = {
      metadata: { baseURL: "https://meta.example.com/" },
    };
    expect(resolveServer(serversDoc(), null, null, ctx, "")).toBe("https://meta.example.com/");

    // configuration.server wins over metadata.baseURL.
    ctx["configuration"] = { server: "https://config.example.com" };
    expect(resolveServer(serversDoc(), null, null, ctx, "")).toBe("https://config.example.com");
  });
});
