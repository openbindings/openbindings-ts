import { describe, it, expect } from "vitest";
import { parseRef, buildJsonPointerRef, sanitizeKey, uniqueKey, mergeParameters } from "./util.js";

describe("parseRef", () => {
  it("parses a standard JSON pointer ref", () => {
    const result = parseRef("#/paths/~1users/get");
    expect(result).toEqual({ path: "/users", method: "get" });
  });

  it("parses without leading #/", () => {
    const result = parseRef("paths/~1users~1{id}/delete");
    expect(result).toEqual({ path: "/users/{id}", method: "delete" });
  });

  it("handles tilde escaping correctly", () => {
    const result = parseRef("#/paths/~1a~0b~1c/post");
    expect(result).toEqual({ path: "/a~b/c", method: "post" });
  });

  it("normalizes method to lowercase", () => {
    const result = parseRef("#/paths/~1users/GET");
    expect(result).toEqual({ path: "/users", method: "get" });
  });

  it("throws for too few parts", () => {
    expect(() => parseRef("#/paths")).toThrow("must be in format");
  });

  it("throws for non-paths prefix", () => {
    expect(() => parseRef("#/components/schemas/get")).toThrow("must be in format");
  });

  it("throws for invalid HTTP method", () => {
    expect(() => parseRef("#/paths/~1users/connect")).toThrow("invalid HTTP method");
  });
});

describe("buildJsonPointerRef", () => {
  it("builds a ref from path and method", () => {
    expect(buildJsonPointerRef("/users", "get")).toBe("#/paths/~1users/get");
  });

  it("handles nested paths", () => {
    expect(buildJsonPointerRef("/users/{id}/posts", "post")).toBe(
      "#/paths/~1users~1{id}~1posts/post",
    );
  });

  it("round-trips with parseRef", () => {
    const original = { path: "/a~b/c", method: "put" };
    const ref = buildJsonPointerRef(original.path, original.method);
    const parsed = parseRef(ref);
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

  it("preserves dots and hyphens", () => {
    expect(sanitizeKey("users.get-all")).toBe("users.get-all");
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
