import { describe, it, expect } from "vitest";
import { parseSelector, buildJsonPointerSelector, sanitizeKey, uniqueKey, mergeParameters, loadOpenAPIDocument } from "./util.js";

describe("parseSelector", () => {
  it("parses a standard JSON pointer selector", () => {
    const result = parseSelector("#/paths/~1users/get");
    expect(result).toEqual({ path: "/users", method: "get" });
  });

  // OAPI-D-03: the selector MUST be a JSON Pointer of the exact form
  // #/paths/<escaped-path>/<method>. A prefix-less spelling was previously
  // accepted leniently; that acceptance was non-conformant.
  it("refuses a selector without the #/paths/ prefix (OAPI-D-03)", () => {
    expect(() => parseSelector("paths/~1users~1{id}/delete")).toThrow("must be a JSON Pointer");
  });

  // OAPI-D-03: the path segment carries RFC 6901 escaping, so a conformant
  // selector has exactly one path token. Unescaped multi-token spellings were
  // previously accepted leniently; that acceptance was non-conformant.
  it("refuses unescaped path tokens (OAPI-D-03)", () => {
    expect(() => parseSelector("#/paths/users/posts/get")).toThrow("must be a JSON Pointer");
  });

  it("handles tilde escaping correctly", () => {
    const result = parseSelector("#/paths/~1a~0b~1c/post");
    expect(result).toEqual({ path: "/a~b/c", method: "post" });
  });

  // OAPI-D-03: the method is lowercase exactly as the artifact spells it —
  // acceptance never case-folds. (This flips the previous lenient
  // lower-casing pin, which was non-conformant.)
  it("refuses an uppercase method, never case-folds (OAPI-D-03)", () => {
    expect(() => parseSelector("#/paths/~1users/GET")).toThrow("lowercase");
  });

  it("throws for too few parts", () => {
    expect(() => parseSelector("#/paths")).toThrow("must be a JSON Pointer");
  });

  it("throws for non-paths prefix", () => {
    expect(() => parseSelector("#/components/schemas/get")).toThrow("must be a JSON Pointer");
  });

  it("throws for invalid HTTP method", () => {
    expect(() => parseSelector("#/paths/~1users/connect")).toThrow("invalid HTTP method");
  });
});

describe("buildJsonPointerSelector", () => {
  it("builds a selector from path and method", () => {
    expect(buildJsonPointerSelector("/users", "get")).toBe("#/paths/~1users/get");
  });

  it("handles nested paths", () => {
    expect(buildJsonPointerSelector("/users/{id}/posts", "post")).toBe(
      "#/paths/~1users~1{id}~1posts/post",
    );
  });

  it("round-trips with parseSelector", () => {
    const original = { path: "/a~b/c", method: "put" };
    const selector = buildJsonPointerSelector(original.path, original.method);
    const parsed = parseSelector(selector);
    expect(parsed).toEqual(original);
  });
});

describe("sanitizeKey", () => {
  it("passes through clean keys", () => {
    expect(sanitizeKey("getUser")).toBe("getUser");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeKey("get /users/{id}")).toBe("get__users__id");
  });

  it("strips leading/trailing underscores", () => {
    expect(sanitizeKey("__foo__")).toBe("foo");
  });

  it("returns 'unnamed' for empty result", () => {
    expect(sanitizeKey("!!!")).toBe("unnamed");
  });

  it("replaces an astral-plane character with one underscore, not one per surrogate half", () => {
    expect(sanitizeKey("t-😀-a")).toBe("t-_-a");
  });

  it("preserves dots and hyphens", () => {
    expect(sanitizeKey("users.get-all")).toBe("users.get-all");
  });

  it("prefixes keys that would start with a non-letter (OBI-D-03, Go parity)", () => {
    expect(sanitizeKey("2fa.enable")).toBe("_2fa.enable");
    expect(sanitizeKey("42")).toBe("_42");
    expect(sanitizeKey("123 go")).toBe("_123_go");
    expect(sanitizeKey(".hidden")).toBe("_.hidden");
    expect(sanitizeKey("-flag")).toBe("_-flag");
  });
});

describe("uniqueKey", () => {
  it("returns key directly when not used", () => {
    expect(uniqueKey("foo", new Set())).toBe("foo");
  });

  it("appends _2 on first collision", () => {
    expect(uniqueKey("foo", new Set(["foo"]))).toBe("foo_2");
  });

  it("increments until unique", () => {
    expect(uniqueKey("foo", new Set(["foo", "foo_2", "foo_3"]))).toBe("foo_4");
  });
});

describe("mergeParameters", () => {
  it("returns opParams when pathParams empty", () => {
    const op = [{ name: "id", in: "query" }];
    expect(mergeParameters([], op)).toEqual(op);
  });

  it("returns pathParams when opParams empty", () => {
    const path = [{ name: "id", in: "path" }];
    expect(mergeParameters(path, [])).toEqual(path);
  });

  it("operation params override path params by in+name", () => {
    const pathParams = [
      { name: "id", in: "path", required: true },
      { name: "format", in: "query" },
    ];
    const opParams = [
      { name: "format", in: "query", description: "overridden" },
    ];
    const result = mergeParameters(pathParams, opParams);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "id", in: "path", required: true });
    expect(result[1]).toEqual({ name: "format", in: "query", description: "overridden" });
  });

  it("handles undefined inputs gracefully", () => {
    expect(mergeParameters(undefined, undefined)).toEqual([]);
    expect(mergeParameters(undefined, [{ name: "x", in: "query" }])).toHaveLength(1);
  });
});

describe("loadOpenAPIDocument reference closure", () => {
  it("keeps fragment-only references inside an external Path Item scoped to its document", async () => {
    const root = {
      openapi: "3.1.2",
      info: { title: "t", version: "1" },
      paths: { "/items": { $ref: "./path-item.json" } },
    };
    const external = {
      post: {
        parameters: [{ $ref: "#/Trace" }],
        requestBody: { $ref: "#/Create" },
        responses: { "200": { $ref: "#/Created" } },
      },
      Trace: { name: "trace", in: "query", schema: { type: "string" } },
      Create: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      Created: { description: "ok" },
    };
    const fetch: typeof globalThis.fetch = async (input) => {
      return String(input) === "https://description.example/path-item.json"
        ? new Response(JSON.stringify(external), { status: 200 })
        : new Response("missing", { status: 404 });
    };

    const loaded = await loadOpenAPIDocument(
      "https://description.example/openapi.json",
      root,
      undefined,
      fetch,
    );
    const post = loaded.paths?.["/items"]?.post;
    expect(post?.parameters?.[0]).toMatchObject({ name: "trace", in: "query" });
    expect(post?.requestBody).toMatchObject({ required: true });
    expect(post?.responses?.["200"]).toMatchObject({ description: "ok" });
  });
});
