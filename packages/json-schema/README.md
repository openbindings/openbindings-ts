# Exact, leaf-aware JSON Schema validation

`@openbindings/json-schema` validates plain data with rich leaves (see
`@openbindings/json`) against JSON Schema 2020-12. It runs the pinned, corrected
`json-schema-library` evaluator, which owns traversal, references, applicators
and annotations. This package fixes the draft: numbers compare as exact digits,
a `Decimal` is a number, an `Encoded` is a string, and the value is read in
place. It has no OpenBindings Core dependency.

```ts
import * as json from "@openbindings/json";
import { compile } from "@openbindings/json-schema";

const schema = compile({
  type: "object",
  required: ["file"],
  properties: {
    file: { type: "string", minLength: 8, maxLength: 8 },
    total: { type: "number", multipleOf: 0.1 },
  },
});
const value = { file: json.base64(Uint8Array.of(0, 1, 254, 255)), total: json.number("0.3") };
const report = schema.validate(value);
report.valid;                              // true
report.costs.encodes;                      // 0: length came from Encoded.length, multipleOf from the digits
report.errors;                             // []

const variant = compile({ properties: { file: { pattern: "^[A-Za-z0-9+/=]+$" } } }).validate(value);
variant.costs.encodes;                     // 1: pattern needed the characters once
variant.costs.forcing["schema-constraint"]; // 4 bytes, attributed to the keyword
String(value.file);                        // "AAH+/w==", kept on the value, no second encode

schema.validate({ ...value, total: json.number("0.30000000000000004") }).errors[0]?.code;
// "multiple-of-error": 0.30000000000000004 is not a multiple of 0.1; 0.3 is
```

## What `compile` does

`compile(schema, options)` admits the schema document as a value (a JavaScript
`0.1` in the schema becomes the digits `0.1`; a schema outside the value domain
throws `ValueError ERR_JSON_ADMISSION`), retains that snapshot, and compiles it
once with the library. Options are the library's `compileSchema` options minus
`drafts`. `throwOnInvalidRef` and `throwOnInvalidSchema` default to true;
Raw `remotes` documents are snapshotted before compilation and use the same
draft. Editing the original documents or their array later cannot change the
compiled validator. An explicitly supplied precompiled `remote` registry stays
live and takes precedence over `remotes`. An invalid schema throws the
library's error at compile; an unresolvable reference throws it when the
reference is first resolved, at validate. Bounds beyond the numeric work limit
(4,096 token characters, exponent 10,000) are `ERR_JSON_BUDGET` at compile.

## What `validate` does

`schema.validate(value)` walks the value in place: no copy, no projection, no
handle. A value outside the domain (an accessor, a host object, a cycle, a
non-finite number) is `ValueError ERR_JSON_ADMISSION` before any keyword runs;
an invalid instance is a report, never an exception.

- `type` sees a `Decimal` as `number`, or `integer` when its value is integral,
  and an `Encoded` as `string`.
- `minLength` and `maxLength` read `Encoded.length`; primitive strings are
  measured in code points. Successful metadata-only checks do not encode;
  a failure message that renders the value may require its characters.
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` and
  the count keywords compare exact digits for `Decimal` and primitive numbers.
- `pattern`, `const`, `enum` and `uniqueItems` may need characters, forcing
  reason `schema-constraint`; the value keeps the string. Compatible backing
  may prove equality without encoding. Arbitrary custom encodings need not be
  injective, so different bytes can still be equal logical strings. `format` is an annotation, as
  2020-12 defaults, and never forces.
- Object keywords never see a leaf as an object; array keywords are unchanged.

The report is `{ valid, errors, costs }`. `errors` are the library's records:
a stable `code`, a `message` that renders `Decimal` digits and `Encoded`
strings (rendering may force one `Encoded` under reason `diagnostic`), and
`data` with `pointer` (the library's `#/...` form), the failing `schema` and
the offending `value`, which shares the member. `costs` is the codec counters
delta for this call: encodes, bytes encoded, forcing by reason, bytes copied,
nodes read by admission, trees built by an import.

`schema.validate(foreign, access)` validates foreign storage through a
version-1 `ValueAccess` adapter from `@openbindings/json/advanced`: one import
through `external`, nothing retained. Byte-backed strings reached through
`deferredString` behave as above; an adapter without it yields strings through
`scalar`, attributed `schema-constraint`. An adapter failure is
`ERR_JSON_ADMISSION` with the adapter's error as `cause`.

## Conformance

The repository includes the pinned mandatory 2020-12 corpus and its license.
Its 1,301 cases run through `compile` with exact numbers, and again with every
canonical Base64 string held as an `Encoded` leaf. Other dialects and optional
vocabularies are not advertised.

Both ESM and CJS artifacts privately bundle the corrected evaluator; no consumer
patch configuration is required. The declared `json-schema-library` dependency
supplies its exported types. See `THIRD_PARTY_NOTICES.md` and the repository's
`third_party/json-schema-library` for source patches and reproduction.

## Retired names

`compileValueSchema`, `valueInstance`, `EXACT_DRAFT_2020`, `RETAINED_DRAFT_2020`
and the `compileSchema` re-export remain available as deprecated compatibility APIs.
Each carries a deprecation note pointing at its replacement:
`compile` and `Schema.validate` over plain data with rich leaves.

This is an SDK quality policy, not an amendment to any OpenBindings specification.

## Standalone consumers

Use the same imports in Node 18+ and modern browser module bundles. The evaluator
is privately bundled; `@openbindings/json` remains a shared dependency so values
created by the application and JSONata use the same leaf identities. Another
installation's leaves enter through its explicit access adapter.

This is prerelease source; install coordinated local archives from the build.
No published npm release is implied. Validate rich values directly: neither native
JSON serialization nor a JSON text round trip is required. Exact output types
asserted with `parse<T>` or `evaluate<T>` are not automatically validated.

Each cost report is a delta of library counters, not a time/RSS measurement. Use
fresh values when measuring first encoding; cached strings need no second encode.
Constraint and adapter/resource failures can throw, while an ordinary schema
mismatch returns `{ valid: false, errors, costs }`. Schema instances and ordinary
values need no explicit cleanup; error records may retain the offending member.
