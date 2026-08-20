import { describe, it, expect } from "vitest";
import {
  FAMILY_JSON,
  FAMILY_RAW,
  FAMILY_TEXT,
  FAMILY_URLENCODED,
  acceptHeader,
  buildMultipartBody,
  buildRequestBody,
  buildURLEncodedBody,
  governingResponseMedia,
  isStreamingCapable,
  parseMediaType,
  planRequestBody,
  planRequestBodies,
  successMediaTypes,
  type BodyPlan,
} from "./media.js";
import { BINDING_SPEC, profileForBindingSpec } from "./constants.js";
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
        "selects a request carriage lane",
      );
    }
  });
});

describe("revision-3 media-range carriage existence", () => {
  const options = { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.1.2" };

  it.each([
    ["application/*", { type: "object", properties: { name: { type: "string" } } }],
    ["*/*", { type: "object", properties: { name: { type: "string" } } }],
    ["text/*", { type: "string" }],
    ["image/*", { type: "string", contentEncoding: "base64" }],
    ["image/*", undefined],
    ["image/*", { type: "object" }],
  ])("admits %s when at least one matching concrete member has defined carriage", (range, schema) => {
    const plans = planRequestBodies(
      opWithRequestBody({ [range]: schema === undefined ? {} : { schema } }, true),
      options,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ mediaKey: range, range: true });
  });

  it("admits OAS 3.0 binary image ranges through a possible configured raw member", () => {
    const plans = planRequestBodies(
      opWithRequestBody({ "image/*": { schema: { type: "string", format: "binary" } } }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.0.4" },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ mediaKey: "image/*", range: true });
  });

  it("rejects invalid request declaration syntax", () => {
    const op = opWithRequestBody({ "application/json/extra": { schema: { type: "object" } } }, true);
    expect(() => planRequestBodies(op, {
      profile: profileForBindingSpec(BINDING_SPEC),
      openapiVersion: "3.1.2",
    })).toThrow(/selects a request carriage lane/);
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

  it.each(["AB==", "AQI", "AQI=\n"])(
    "revision 3 rejects non-canonical OAS 3.0 multipart Base64 %j",
    (value) => {
      const media: OpenAPIMediaType = {
        schema: {
          type: "object",
          properties: { file: { type: "string", format: "binary" } },
        },
      };
      const plan = planRequestBody(
        opWithRequestBody({ "multipart/form-data": media }, true),
        { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.0.4" },
      );
      expect(() => buildRequestBody(DOC_30, plan, routedWith({ bodyFields: { file: value } })))
        .toThrow(/invalid canonical base64/);
    },
  );

  it("carries OAS 3.0 binary parts under their declared non-default content type", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: { archive: { type: "string", format: "binary" } },
      },
      encoding: { archive: { contentType: "application/zip" } },
    };
    const plan = planRequestBody(
      opWithRequestBody({ "multipart/form-data": media }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.0.3" },
    );
    const wire = buildRequestBody(
      DOC_30,
      plan,
      routedWith({ bodyFields: { archive: b64("zip-bytes") } }),
    );
    const parts = await formDataParts(wire.body as FormData);
    expect(parts.archive?.[0]).toEqual(["application/zip", "zip-bytes"]);
  });

  it.each([
    new Uint8Array([1, 2]),
    new Blob([new Uint8Array([1, 2])]),
  ])("revision 3 rejects non-JSON multipart binary convenience value %s", (value) => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: { file: { type: "string", format: "binary" } },
      },
    };
    const plan = planRequestBody(
      opWithRequestBody({ "multipart/form-data": media }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.0.4" },
    );
    expect(() => buildRequestBody(DOC_30, plan, routedWith({ bodyFields: { file: value } })))
      .toThrow(/requires a canonical Base64 string/);
    expect(() => buildMultipartBody(DOC_30, media, { file: value })).not.toThrow();
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

  it("revision 3 keeps OAS 3.1 contentEncoding and identity-encoded contentMediaType strings unchanged", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          encoded: {
            type: "string",
            contentMediaType: "image/png",
            contentEncoding: "base64",
          },
          identity: {
            type: "string",
            contentMediaType: "text/custom",
          },
        },
      },
    };
    const fd = buildMultipartBody(DOC_31, media, {
      encoded: "AAH+/w==",
      identity: "literal text",
    }, true);
    const encoded = fd.get("encoded") as File;
    const identity = fd.get("identity") as File;
    expect(encoded.type).toBe("application/octet-stream");
    expect(await encoded.text()).toBe("AAH+/w==");
    expect(identity).toBe("literal text");
  });

  it("revision 3 resolves multipart content keywords through allOf and refuses conflicts", async () => {
    const inherited: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          encoded: {
            allOf: [
              { type: "string" },
              { contentMediaType: "image/png", contentEncoding: "base64" },
            ],
          },
        },
      },
    };
    const fd = buildMultipartBody(DOC_31, inherited, { encoded: "AAH+/w==" }, true);
    expect(await (fd.get("encoded") as File).text()).toBe("AAH+/w==");

    const conflicting: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          encoded: {
            allOf: [
              { type: "string", contentEncoding: "base64" },
              { contentEncoding: "base64url" },
            ],
          },
        },
      },
    };
    expect(() => buildMultipartBody(DOC_31, conflicting, { encoded: "AAH+/w==" }, true))
      .toThrow(/conflicting contentEncoding/);
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

  it("revision 3 recognizes parameterized event-stream capability by parsed base", () => {
    const op: OpenAPIOperation = {
      responses: { "200": { content: { "text/event-stream; charset=utf-8": {} } } },
    };
    expect(isStreamingCapable(op)).toBe(false);
    expect(isStreamingCapable(op, true)).toBe(true);
  });

  it("revision 4 treats parameterized ranges as possible event-stream declarations", () => {
    const op: OpenAPIOperation = {
      responses: { "200": { content: { "text/*; profile=events": {} } } },
    };
    expect(isStreamingCapable(op, true, false)).toBe(false);
    expect(isStreamingCapable(op, true, true)).toBe(true);
  });

  it("revision 3 builds Accept from semantic parameter identities, and a normalized-colliding identity is not advertised", () => {
    const op: OpenAPIOperation = {
      responses: {
        "200": {
          content: {
            'application/json; note="a\\z"': {},
            "text/plain; charset=UTF-8": {},
            "TEXT/PLAIN; CHARSET=utf-8": {},
          },
        },
      },
    };
    // The two text/plain spellings denote one parsed identity in ONE content
    // map: a normalized collision. No response match may be governed by it
    // (section 9.2), so it is not an available representation and advertising
    // it would invite exactly the response the decode lane must refuse. The
    // non-colliding sibling advertises unaffected -- confinement, not a
    // first-key pick between the two spellings.
    expect(acceptHeader(op, true)).toBe("application/json; note=az");
  });

  it("a normalized collision confines to its own content map, not to the Accept set", () => {
    const op: OpenAPIOperation = {
      responses: {
        "200": { content: { "text/plain; charset=UTF-8": {} } },
        default: { content: { "TEXT/PLAIN; CHARSET=utf-8": {} } },
      },
    };
    // One identity declared by two DIFFERENT response content maps is not a
    // collision: section 9.2's unit is one content map. The set carries the
    // identity once, and the spelling is chosen deterministically rather than
    // by whichever key was enumerated first.
    expect(acceptHeader(op, true)).toBe("text/plain; charset=UTF-8");
  });
});

describe("revision-3 response media governance", () => {
  it("ignores response ranges when a concrete sibling governs", () => {
    expect(governingResponseMedia({
      content: { "application/json": {}, "*/*": {} },
    }, "application/json", true)).toBe("application/json");
  });

  it("confines a normalized concrete collision to the colliding identity", () => {
    const content = {
      "text/plain": {},
      "application/json; charset=UTF-8": {},
      "APPLICATION/JSON; CHARSET=utf-8": {},
    };
    // The non-colliding sibling remains a usable alternative...
    expect(governingResponseMedia({ content }, "text/plain", true)).toBe("text/plain");
    // ...while no response match may be governed by the colliding identity.
    expect(() => governingResponseMedia({ content }, "application/json; charset=utf-8", true))
      .toThrow(/normalized collision/);
  });

  it("confines a normalized RANGE collision without poisoning a clean concrete match", () => {
    // Two colliding range keys cannot govern a concrete decode at all in
    // revision 3, and under confinement they no longer poison the concrete
    // sibling that can.
    expect(governingResponseMedia({
      content: {
        "application/json": {},
        "*/*; charset=UTF-8": {},
        "*/*; CHARSET=utf-8": {},
      },
    }, "application/json", true)).toBe("application/json");
  });

  it("a content map whose ONLY entries collide governs nothing", () => {
    expect(() => governingResponseMedia({
      content: {
        "application/json; charset=UTF-8": {},
        "APPLICATION/JSON; CHARSET=utf-8": {},
      },
    }, "application/json; charset=utf-8", true)).toThrow(/normalized collision/);
  });

  it("matches charset values case-insensitively and fully unescapes quoted pairs", () => {
    expect(governingResponseMedia({
      content: { 'text/plain; charset=UTF-8; note="a\\z"': {} },
    }, "text/plain; charset=utf-8; note=az", true)).toBe("text/plain; charset=UTF-8; note=az");
  });

  it("allows trailing OWS after parameter values while rejecting OWS around equals", () => {
    expect(parseMediaType("text/plain; note=x ; charset=utf-8", true).params).toEqual({
      note: "x",
      charset: "utf-8",
    });
    expect(parseMediaType('text/plain; note="x" ', true).params["note"]).toBe("x");
    expect(() => parseMediaType("text/plain; note =x", true)).toThrow();
    expect(() => parseMediaType("text/plain; note= x", true)).toThrow();
  });

  it("accepts RFC 9110 empty parameter slots in revision 3", () => {
    expect(parseMediaType("application/json;", true).canonical).toBe("application/json");
    expect(parseMediaType("application/json;; charset=utf-8; ;", true).canonical)
      .toBe("application/json; charset=utf-8");
    expect(() => parseMediaType("application/json;")).toThrow();
  });

  it("treats only structural wildcards as ranges in revision 3", () => {
    expect(parseMediaType("application/vnd.foo*bar", true).base).toBe("application/vnd.foo*bar");
    expect(() => parseMediaType("application/*", true)).toThrow();
  });

  it("accepts prototype-like parameter names in the revision-3 parser", () => {
    const params = parseMediaType("text/plain; constructor=x; __proto__=y", true).params;
    expect(Object.hasOwn(params, "constructor")).toBe(true);
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(params["constructor"]).toBe("x");
    expect(params["__proto__"]).toBe("y");
  });

  it("compares registered nested type parameters semantically and unknown parameters bytewise", () => {
    const upper = parseMediaType(
      'multipart/related; type="Application/JSON; Charset=UTF-8"; profile=Case',
      true,
    );
    const lower = parseMediaType(
      'multipart/related; type="application/json; charset=utf-8"; profile=Case',
      true,
    );
    expect(upper.identity).toBe(lower.identity);
    expect(parseMediaType('multipart/related; profile=case', true).identity)
      .not.toBe(parseMediaType('multipart/related; profile=Case', true).identity);
  });

  it.each([
    "text/plain/extra",
    "text /plain",
    "text/plain; bad name=x",
    "text/plain; note=",
    "text/plain; note=two words",
    "text/plain; note =x",
    "text/plain; note= x",
    'text/plain; note="line\nfeed"',
    'text/plain; note="\\\n"',
    'text/plain; note="Ā"',
  ])("revision 3 rejects invalid RFC 9110 media syntax %j", (value) => {
    expect(() => parseMediaType(value, true)).toThrow();
  });

  it("keeps the legacy parser's former minimal malformed-base acceptance", () => {
    expect(parseMediaType("text/plain/extra").base).toBe("text/plain/extra");
    expect(() => parseMediaType("text/plain/extra", true)).toThrow();
  });
});

// §9.2: a type-absent part schema refuses before dispatch on EVERY accepted
// edition, on grounds that differ per line; a part schema declaring one
// non-null anyOf/oneOf branch beside {type:"null"} branches collapses to that
// branch, with JSON null eliding the optional part. Mirrors Go's
// TestRevision3MultipartTypeAbsentPartRefusesOn30/On31 and
// TestRevision3MultipartNullableChoiceCollapsesToBranchCarriage.
describe("§9.2 type-absent and nullable-choice parts", () => {
  // The 3.0 half. It read "admits a type-absent part on the 3.0 line and keys
  // its per-type default from the value" until 2026-08-20, when escalation M2
  // deleted the value-keyed convention: no accepted 3.0 edition states a
  // default contentType row that reaches a declaration with no `type`, and
  // this specification now authors none for that residue either.
  it.each([["3.0.0"], ["3.0.1"], ["3.0.2"], ["3.0.3"], ["3.0.4"]])(
    "refuses a type-absent part on OAS %s, authoring no row",
    (edition) => {
      const media: OpenAPIMediaType = {
        schema: { type: "object", properties: { file: { description: "Profile picture file" } } },
      };
      expect(() => planRequestBody(
        opWithRequestBody({ "multipart/form-data": media }, true),
        { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: edition },
      )).toThrow(/no default part Content-Type row on any accepted OAS 3.0 edition/);
    },
  );

  // The other half, on its own ground: every accepted 3.1 edition STATES
  // application/octet-stream for a part whose `type` is absent, and this
  // revision defines no JSON-to-octet part boundary. One outcome, two grounds.
  it.each([["3.1.0"], ["3.1.1"], ["3.1.2"]])("refuses a type-absent part on OAS %s", (edition) => {
    const media: OpenAPIMediaType = {
      schema: { type: "object", properties: { file: { description: "Profile picture file" } } },
    };
    expect(() => planRequestBody(
      opWithRequestBody({ "multipart/form-data": media }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: edition },
    )).toThrow(/application\/octet-stream/);
  });

  it("collapses a nullable choice to the non-null branch's carriage and elides null", async () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          file: {
            anyOf: [
              { type: "string", contentMediaType: "application/octet-stream" },
              { type: "null" },
            ],
            description: "nullable upload",
          },
          file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          options: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
        },
      },
    };
    const plan = planRequestBody(
      opWithRequestBody({ "multipart/form-data": media }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.1.0" },
    );

    let wire = buildRequestBody(DOC_31, plan, routedWith({
      bodyFields: { file: "raw-text", file_id: "id-1", options: { k: "v" } },
    }));
    let parts = await formDataParts(wire.body as FormData);
    expect(parts.file?.[0]).toEqual(["", "raw-text"]);
    expect(parts.file_id?.[0]).toEqual(["", "id-1"]);
    expect(parts.options?.[0]).toEqual(["application/json", '{"k":"v"}']);

    wire = buildRequestBody(DOC_31, plan, routedWith({
      bodyFields: { file: null, file_id: "id-2" },
    }));
    parts = await formDataParts(wire.body as FormData);
    expect(parts.file).toBeUndefined();
    expect(parts.file_id?.[0]).toEqual(["", "id-2"]);
  });

  it("still refuses a choice with more than one non-null branch", () => {
    const media: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: { pick: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      },
    };
    expect(() => planRequestBody(
      opWithRequestBody({ "multipart/form-data": media }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.1.0" },
    )).toThrow(/choice applicator/);
    const nullable: OpenAPIMediaType = {
      schema: {
        type: "object",
        properties: {
          pick: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
        },
      },
    };
    expect(() => planRequestBody(
      opWithRequestBody({ "multipart/form-data": nullable }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.1.0" },
    )).toThrow(/choice applicator/);
  });

  it("applies the same rules on the urlencoded lane", () => {
    // The nullable-choice collapse is read under the 3.1 line; the
    // type-absent field is read under the 3.0 line, the only line whose
    // stated rows leave it open.
    const choice: OpenAPIMediaType = {
      schema: { type: "object", properties: { tag: { anyOf: [{ type: "string" }, { type: "null" }] } } },
    };
    expect(() => planRequestBody(
      opWithRequestBody({ "application/x-www-form-urlencoded": choice }, true),
      { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.1.2" },
    )).not.toThrow();
    expect(buildURLEncodedBody(choice, { tag: "t1" }, true, "3.1.2")).toBe("tag=t1");
    expect(buildURLEncodedBody(choice, { tag: null }, true, "3.1.2")).toBe("");

    const typeAbsent: OpenAPIMediaType = {
      schema: { type: "object", properties: { note: { description: "free-form" } } },
    };
    for (const edition of ["3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4"]) {
      expect(() => planRequestBody(
        opWithRequestBody({ "application/x-www-form-urlencoded": typeAbsent }, true),
        { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: edition },
      )).toThrow(/no default part Content-Type row on any accepted OAS 3.0 edition/);
    }
    for (const edition of ["3.1.0", "3.1.1", "3.1.2"]) {
      expect(() => planRequestBody(
        opWithRequestBody({ "application/x-www-form-urlencoded": typeAbsent }, true),
        { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: edition },
      )).toThrow(/application\/octet-stream/);
    }
  });
});

// §9.2's string-carriage lane, ruled 2026-08-15 and scope-corrected the same
// day: a concrete non-JSON, non-form selection carries the supplied string
// when its GOVERNING SCHEMA resolves to `type: string` AND its media type is
// character data. Both halves are derived — the OAS decides the value is a
// string, the media-type registration decides whether a string has an octet
// image — so the lane is never keyed on the caller's value and never on the
// media type's primary type alone.
describe("string-carriage lane (declaration-scoped)", () => {
  const options = { profile: profileForBindingSpec(BINDING_SPEC), openapiVersion: "3.1.2" };

  // Character data: the text tree (RFC 6838 §4.2.1), the XML registrations
  // and the +xml suffix (RFC 7303 §9.1/§9.2/§9.6.1).
  it.each([
    ["text/plain"],
    ["text/csv"],
    ["text/markdown"],
    ["text/x-markdown"],
    ["application/xml"],
    ["text/xml"],
    ["image/svg+xml"],
  ])("carries a string-declared %s body", (media) => {
    const plans = planRequestBodies(
      opWithRequestBody({ [media]: { schema: { type: "string" } } }, true),
      options,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ mediaKey: media, family: FAMILY_TEXT, synthetic: true });
  });

  // NOT character data: no registration establishes a charset for these, so a
  // caller-supplied string has no defined octet image and the declaration
  // keeps the byte lanes. Under OAS 3.1 `format: binary` is an annotation
  // with no assertion force, so the arrow-stream declaration resolves to a
  // bare `type: string` and is decided entirely by its media type.
  it.each([
    ["application/x-custom"],
    ["application/vnd.apache.arrow.stream"],
    ["application/octet-stream"],
    ["application/cbor"],
  ])("refuses a string-declared %s body: no charset applies", (media) => {
    for (const schema of [{ type: "string" }, { type: "string", format: "binary" }]) {
      expect(() => planRequestBodies(
        opWithRequestBody({ [media]: { schema } }, true),
        options,
      )).toThrow(/selects a request carriage lane/);
    }
  });

  // A schema that asserts nothing makes no claim the body is a string, so it
  // is the same declaration as an omitted schema and takes the
  // artifact-authorized byte lane — including for character-data media. This
  // is the corner the 2026-08-15 ruling pass filed rather than decided; it is
  // settled by the same authority that scopes the lane.
  it.each([
    ["text/plain", true],
    ["text/plain", {}],
    ["application/vnd.apache.arrow.stream", true],
    ["application/vnd.apache.arrow.stream", {}],
  ])("carries an unconstrained %s declaration at the byte boundary", (media, schema) => {
    const plans = planRequestBodies(
      opWithRequestBody({ [media]: { schema } }, true),
      options,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ mediaKey: media, family: FAMILY_RAW, rawBoundary: true });
  });

  it.each([
    ["text/plain"],
    ["text/csv"],
    ["text/json"],
    ["application/xml"],
    ["text/xml"],
  ])("refuses an object-declared %s body: no lane builds a document from an object model", (media) => {
    expect(() => planRequestBodies(
      opWithRequestBody({ [media]: { schema: { type: "object", properties: { a: { type: "string" } } } } }, true),
      options,
    )).toThrow(/selects a request carriage lane/);
  });

  it("keeps the incumbent text lane declaration-scoped: a non-string declaration selects nothing", () => {
    expect(() => planRequestBodies(
      opWithRequestBody({ "text/plain": { schema: { anyOf: [{ type: "string" }, { type: "object" }] } } }, true),
      options,
    )).toThrow(/selects a request carriage lane/);
  });

  it("leaves the artifact-authorized byte lanes first, with no text carve-out", () => {
    // A schema-omitted text declaration is a schema-omitted declaration like
    // any other: it takes the raw lane rather than being orphaned between two.
    const omitted = planRequestBodies(opWithRequestBody({ "text/csv": {} }, true), options);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ mediaKey: "text/csv", family: FAMILY_RAW });

    // OAS 3.0 `format: binary` is the artifact declaring octets; it wins.
    const binary = planRequestBodies(
      opWithRequestBody({ "text/csv": { schema: { type: "string", format: "binary" } } }, true),
      { ...options, openapiVersion: "3.0.4" },
    );
    expect(binary).toHaveLength(1);
    expect(binary[0]).toMatchObject({ mediaKey: "text/csv", family: FAMILY_RAW });
  });

  it("refuses an unsupported charset for the whole family, not just text/plain", () => {
    expect(() => planRequestBodies(
      opWithRequestBody({ "text/csv; charset=shift_jis": { schema: { type: "string" } } }, true),
      options,
    )).toThrow(/charset/);
  });

  it("encodes the emitted body under the declared charset for the whole family", () => {
    const plans = planRequestBodies(
      opWithRequestBody({ "text/csv; charset=iso-8859-1": { schema: { type: "string" } } }, true),
      options,
    );
    expect(plans).toHaveLength(1);
    const wire = buildRequestBody(DOC_31, plans[0]!, routedWith({ bodyValue: "é", bodySet: true }));
    expect(wire.contentType).toBe("text/csv; charset=iso-8859-1");
    expect(Array.from(wire.body as Uint8Array)).toEqual([0xe9]);
  });

  it("names the declaration, not text/plain, when the supplied value is not a string", () => {
    const plans = planRequestBodies(
      opWithRequestBody({ "application/xml": { schema: { type: "string" } } }, true),
      options,
    );
    expect(() =>
      buildRequestBody(DOC_31, plans[0]!, routedWith({ bodyValue: 42, bodySet: true })),
    ).toThrow("request media application/xml declares a string body");
  });
});
