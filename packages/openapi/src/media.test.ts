import { describe, it, expect } from "vitest";
import {
  FAMILY_JSON,
  FAMILY_TEXT,
  FAMILY_URLENCODED,
  acceptHeader,
  buildMultipartBody,
  buildRequestBody,
  buildURLEncodedBody,
  isStreamingCapable,
  planRequestBody,
  successMediaTypes,
  type BodyPlan,
} from "./media.js";
import type { OpenAPIDocument, OpenAPIMediaType, OpenAPIOperation } from "./types.js";
import type { RoutedInput } from "./params.js";

// Mirrors Go's media_test.go: §9.2 (OAPI-P-04) request media selection,
// multipart part encoding, urlencoded serialization, and the §8
// declared-media facts.

function opWithRequestBody(
  content: Record<string, OpenAPIMediaType>,
  required: boolean,
): OpenAPIOperation {
  return { requestBody: { required, content } };
}

function routedWith(overrides: Partial<RoutedInput>): RoutedInput {
  return {
    resolvedPath: "/x",
    queryUnits: [],
    headers: [],
    cookieUnits: [],
    bodyFields: {},
    bodyValue: undefined,
    bodySet: false,
    populated: { header: new Set(), query: new Set(), cookie: new Set() },
    ...overrides,
  };
}

const DOC_30: OpenAPIDocument = { openapi: "3.0.3" };
const DOC_31: OpenAPIDocument = { openapi: "3.1.0" };

// OAPI-P-04 preserves all artifact-declared admissible candidates without a
// normative preference. This helper's deterministic fallback is lexical; it
// is an implementation convention, not a binding-spec priority.
describe("planRequestBody — deterministic unconfigured selection", () => {
  const cases: Array<[string, Record<string, OpenAPIMediaType>, string, string]> = [
    [
      "exact json wins over everything",
      {
        "application/json": {},
        "application/vnd.api+json": {},
        "multipart/form-data": {},
        "application/x-www-form-urlencoded": {},
        "text/plain": {},
      },
      "application/json",
      FAMILY_JSON,
    ],
    [
      "lexicographically least +json",
      {
        "application/vnd.b+json": {},
        "application/vnd.a+json": {},
        "multipart/form-data": {},
      },
      "application/vnd.a+json",
      FAMILY_JSON,
    ],
    [
      "lexical fallback preserves multipart and urlencoded as alternatives",
      { "application/x-www-form-urlencoded": {}, "multipart/form-data": {} },
      "application/x-www-form-urlencoded",
      FAMILY_URLENCODED,
    ],
    [
      "urlencoded over text/plain",
      { "text/plain": {}, "application/x-www-form-urlencoded": {} },
      "application/x-www-form-urlencoded",
      FAMILY_URLENCODED,
    ],
    ["text/plain last", { "text/plain": {} }, "text/plain", FAMILY_TEXT],
    [
      "parameters remain part of the exact declared identity",
      { "application/JSON; charset=utf-8": {} },
      "application/json; charset=utf-8",
      FAMILY_JSON,
    ],
  ];
  for (const [name, content, wantType, wantFamily] of cases) {
    it(name, () => {
      const plan = planRequestBody(opWithRequestBody(content, false));
      expect(plan.mediaType).toBe(wantType);
      expect(plan.family).toBe(wantFamily);
    });
  }

  // Out-of-family declarations (a raw binary body, ranges only) refuse
  // loudly pre-dispatch (OAPI-P-04).
  it("refuses out-of-family-only declarations loudly", () => {
    const refused: Array<Record<string, OpenAPIMediaType>> = [
      { "application/octet-stream": {} },
      { "image/png": {} },
      { "*/*": {} }, // a range is not a concrete declaration
      { "application/*": {} }, // ditto
    ];
    for (const content of refused) {
      expect(() => planRequestBody(opWithRequestBody(content, false))).toThrow(
        "outside the families",
      );
    }
  });
});

// A non-object JSON body schema makes the plan synthetic (§9.1).
describe("planRequestBody — synthetic modes", () => {
  it("array body schema is synthetic", () => {
    const plan = planRequestBody(
      opWithRequestBody({ "application/json": { schema: { type: "array" } } }, false),
    );
    expect(plan.synthetic).toBe(true);
  });

  it("object body schema is not synthetic and carries declared property names", () => {
    const plan = planRequestBody(
      opWithRequestBody(
        {
          "application/json": {
            schema: { type: "object", properties: { a: { type: "string" } } },
          },
        },
        false,
      ),
    );
    expect(plan.synthetic).toBe(false);
    expect(plan.props?.has("a")).toBe(true);
  });

  it("text/plain always rides the synthetic lane", () => {
    const plan = planRequestBody(opWithRequestBody({ "text/plain": {} }, false));
    expect(plan.synthetic).toBe(true);
  });

  // §9.1's object determination is declaration-only, one predicate shared
  // with synthesis (bodySchemaFlattens): a TYPELESS schema — neither
  // `properties` nor an explicit object type — is non-object, so the plan
  // is synthetic exactly as the synthesized contract wraps it.
  it("typeless body schema is synthetic", () => {
    const plan = planRequestBody(
      opWithRequestBody({ "application/json": { schema: {} } }, false),
    );
    expect(plan.synthetic).toBe(true);
  });

  // The other half of the declaration: `properties` without a type is
  // object by declaration — flattened, never synthetic.
  it("properties-without-type schema is not synthetic and carries property names", () => {
    const plan = planRequestBody(
      opWithRequestBody(
        { "application/json": { schema: { properties: { a: { type: "string" } } } } },
        false,
      ),
    );
    expect(plan.synthetic).toBe(false);
    expect(plan.props?.has("a")).toBe(true);
  });

  // A 3.1 two-element type array is not an EXPLICIT object type (only the
  // single-element form is): synthetic without properties.
  it("nullable-object schema without properties is synthetic", () => {
    const plan = planRequestBody(
      opWithRequestBody({ "application/json": { schema: { type: ["object", "null"] } } }, false),
    );
    expect(plan.synthetic).toBe(true);
  });
});

// The remaining-body rule (§9.1): JSON-family selection with every field
// consumed by parameters sends {} when required, omits the body otherwise.
describe("buildRequestBody — the remaining-body rule", () => {
  const basePlan: BodyPlan = {
    declared: true,
    required: false,
    mediaKey: "application/json",
    mediaType: "application/json",
    media: null,
    family: FAMILY_JSON,
    synthetic: false,
  };

  it("sends {} when the request body is required", () => {
    const wire = buildRequestBody(DOC_30, { ...basePlan, required: true }, routedWith({}));
    expect(wire.body).toBe("{}");
    expect(wire.contentType).toBe("application/json");
  });

  it("omits the body when the request body is optional", () => {
    const wire = buildRequestBody(DOC_30, basePlan, routedWith({}));
    expect(wire.body).toBeUndefined();
    expect(wire.contentType).toBe("");
  });

  // Synthetic unwrap: the `body` property's value IS the request body (§9.1).
  it("unwraps the synthetic body property at the wire", () => {
    const wire = buildRequestBody(
      DOC_30,
      { ...basePlan, synthetic: true },
      routedWith({ bodyValue: [1, 2], bodySet: true }),
    );
    expect(wire.body).toBe("[1,2]");
    expect(wire.contentType).toBe("application/json");
  });

  // text/plain's selection condition: a non-string body value is a loud
  // refusal (OAPI-P-04).
  it("sends a text/plain string body verbatim and refuses a non-string one", () => {
    const textPlan: BodyPlan = {
      ...basePlan,
      mediaKey: "text/plain",
      mediaType: "text/plain",
      family: FAMILY_TEXT,
      synthetic: true,
    };
    const wire = buildRequestBody(DOC_30, textPlan, routedWith({ bodyValue: "hello", bodySet: true }));
    expect(wire.body).toBe("hello");
    expect(wire.contentType).toBe("text/plain");

    expect(() =>
      buildRequestBody(DOC_30, textPlan, routedWith({ bodyValue: 42, bodySet: true })),
    ).toThrow("not a string");
  });
});

/** Splits built FormData into part name → [content-type, text][]. */
async function formDataParts(fd: FormData): Promise<Record<string, Array<[string, string]>>> {
  const entries: Array<[string, FormDataEntryValue]> = [];
  fd.forEach((value, name) => entries.push([name, value]));
  const parts: Record<string, Array<[string, string]>> = {};
  for (const [name, value] of entries) {
    const entry: [string, string] =
      typeof value === "string" ? ["", value] : [value.type, await value.text()];
    (parts[name] ??= []).push(entry);
  }
  return parts;
}

function b64(bytes: number[] | string): string {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(s);
}

describe("buildMultipartBody", () => {
  // 3.0.x: format:binary signals a binary part; with no declarable encoding
  // in 3.0, the caller's string is Base64-decoded (the boundary encoding).
  it("decodes a 3.0 format:binary part from Base64 (the boundary encoding)", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          file: { type: "string", format: "binary" },
          desc: { type: "string" },
        },
      },
    };
    const fd = buildMultipartBody(DOC_30, media, {
      file: b64("raw-bytes"),
      desc: "a file",
    });
    const parts = await formDataParts(fd);
    expect(parts["file"]?.[0]).toEqual(["application/octet-stream", "raw-bytes"]);
    expect(parts["desc"]?.[0]?.[1]).toBe("a file");

    // An invalid base64 string is a loud error, never silent bytes.
    expect(() => buildMultipartBody(DOC_30, media, { file: "!!not-base64!!" })).toThrow(
      "invalid base64",
    );
  });

  // 3.1.x: a string schema carrying contentMediaType/contentEncoding
  // signals binary; a declared contentEncoding decides the decode, and the
  // declared contentMediaType rides as the part's content type.
  it("honors 3.1 contentMediaType/contentEncoding keywords", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          img: {
            type: "string",
            contentMediaType: "image/png",
            contentEncoding: "base64url",
          },
        },
      },
    };
    const payload = b64([0xff, 0xfe]).replace(/\+/g, "-").replace(/\//g, "_");
    const fd = buildMultipartBody(DOC_31, media, { img: payload });
    const parts = await formDataParts(fd);
    expect(parts["img"]?.[0]?.[0]).toBe("image/png");
    // Bytes decoded per contentEncoding base64url (0xff 0xfe is invalid
    // UTF-8, so compare the raw bytes).
    const img = fd.get("img") as File;
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([0xff, 0xfe]);
  });

  // Parts that are not binary-signaled follow the per-type defaults:
  // objects as application/json parts, primitives as plain fields; the
  // encoding object's contentType overrides; declared arrays expand into
  // repeated parts.
  it("applies per-type part defaults and the encoding object", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          meta: { type: "object" },
          count: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
      },
      encoding: {
        note: { contentType: "text/markdown" },
      },
    };
    const fd = buildMultipartBody(DOC_30, media, {
      meta: { k: "v" },
      count: 42,
      tags: ["a", "b"],
      note: "# hi",
    });
    const parts = await formDataParts(fd);
    expect(parts["meta"]?.[0]).toEqual(["application/json", '{"k":"v"}']);
    expect(parts["count"]?.[0]?.[1]).toBe("42");
    expect(parts["tags"]?.map(([, text]) => text)).toEqual(["a", "b"]);
    expect(parts["note"]?.[0]).toEqual(["text/markdown", "# hi"]);
  });

  // An in-process Uint8Array value passes through raw (it cannot have
  // arrived as JSON) — the counterpart of Go's []byte passthrough.
  it("passes an in-process Uint8Array through raw", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: { file: { type: "string", format: "binary" } },
      },
    };
    const fd = buildMultipartBody(DOC_30, media, { file: new Uint8Array([0x01, 0x02]) });
    const file = fd.get("file") as File;
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x01, 0x02]);
  });
});

// urlencoded bodies serialize per the OAS encoding rules: form/explode=true
// default, overridable per field.
describe("buildURLEncodedBody", () => {
  it("serializes fields per the encoding object with form defaults, sorted", () => {
    const media: OpenAPIMediaType = {
      encoding: {
        tags: { style: "pipeDelimited", explode: false },
      },
    };
    const body = buildURLEncodedBody(media, {
      name: "a b",
      ids: [1, 2],
      tags: ["x", "y"],
    });
    // Sorted field order: ids (form explode default → repeated), name, tags
    // (pipeDelimited non-explode via the encoding object).
    expect(body).toBe("ids=1&ids=2&name=a%20b&tags=x|y");
  });
});

// The Accept header advertises the declared concrete media types of the
// SUCCESS responses (2xx literals + the 2XX range; default never
// participates; ranges are not concrete); absent any declaration,
// application/json (§9.2, §8).
describe("successMediaTypes / acceptHeader / isStreamingCapable", () => {
  it("collects success media only — 2xx literals and the 2XX range; ranges excluded", () => {
    const op: OpenAPIOperation = {
      responses: {
        "200": { content: { "application/json": {}, "text/event-stream": {} } },
        "2XX": { content: { "text/csv": {} } },
        "404": { content: { "application/problem+json": {} } },
        default: { content: { "application/xml": {}, "*/*": {} } },
      },
    };
    expect(successMediaTypes(op)).toEqual(["application/json", "text/csv", "text/event-stream"]);
    expect(isStreamingCapable(op)).toBe(true);
  });

  it("omits Accept when the artifact declares no success media", () => {
    const op: OpenAPIOperation = { responses: { "204": { description: "no content" } } };
    expect(acceptHeader(op)).toBe("");
    expect(isStreamingCapable(op)).toBe(false);
  });

  it("a default-only text/event-stream confers capability when default can govern 2xx", () => {
    const op: OpenAPIOperation = {
      responses: { default: { content: { "text/event-stream": {} } } },
    };
    expect(isStreamingCapable(op)).toBe(true);
  });
});
