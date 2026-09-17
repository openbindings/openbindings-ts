# Legacy JSON APIs

These deprecated interfaces remain available for compatibility. New code should use the [ordinary value API](README.md). This document describes the older handles and numeric carriers, not the new `Decimal` and `Encoded` surface.

# Exact JSON values

Protocol-neutral JSON carriage for the OpenBindings Project's implementations.
This implementation policy is not an extra OpenBindings conformance rule.

```ts
import { parseJSON, stringifyJSON, numberToken, equalJSON } from "@openbindings/json";

const data = parseJSON('{"id":9007199254740993,"price":0.10}');
const wire = stringifyJSON(data); // numeric JSON, not quoted strings or wrappers
equalJSON(parseJSON("0.1"), parseJSON("0.10")); // true
numberToken(parseJSON("9007199254740993")); // exact token, no implicit coercion
```

Safe literal integers remain native numbers. Other numeric tokens use immutable,
authenticated RawJSON objects from the native runtime or pinned `core-js-pure`.
`JSONNumber` and `isJSONNumber` recognize those carriers; a lookalike application
object is not a carrier. Use these encode/decode functions at byte boundaries.
The package does not change global JSON methods. Native numbers supplied by a
caller retain only the value already in that number, not discarded source text.

`stringifyJSON` and `cloneJSON` require actual JSON data: they reject nonfinite
numbers, undefined members, sparse arrays, cycles, accessors and custom host
objects instead of invoking hooks or silently changing values. `cloneValueGraph`
is an internal-model detachment utility: it additionally preserves aliases,
cycles and optional undefined metadata, and is not a JSON admission check.
Structured cloning or cross-realm transport is not a carrier protocol; use exact
encoding/decoding at an actual transport boundary.

Equality compares numeric values (including equivalent decimal spellings and
signed zero), ignores object-member order, and preserves types, presence,
Unicode content and array order. It is not canonicalization or persistent
identity. Numeric predicates currently bound tokens to 4,096 characters and
explicit exponents to ±10,000 before potentially expensive numeric work.
Exceeding a predicate's budget throws `JSONCapabilityError`, not inequality or
invalid data. Parsing and encoding do not expand exponents or apply these limits.
These candidate limits remain subject to resource/performance qualification.

`JSONValueSet` keeps detached values in first-insertion order with the same
equality and numeric-operation budget. Its private structural index only narrows
comparisons; exact equality verifies every hit. Iteration returns detached
values. No index key is exposed or intended for storage, signing or identity.

The parser uses `core-js-pure` 3.50.0; numeric operations use `lossless-json`
4.3.1 with a qualified zero-comparison correction and bounded BigInt divisibility.
Boundary-specific duplicate, Unicode, lexical and media policies belong to their
respective callers. This package does not implement or qualify JSONata transforms.
# Retained values and native projections

The additive `@openbindings/json/values` entry point works without Open Bindings
documents, invokers or evaluators. JSON describes a value's logical meaning;
retained storage does not have to be JSON text.

`parseRetainedJSON(text, limits?)` uses the same exact source-token parser as
`parseJSON`, constructing owned retained storage during its traversal. Use it
when an actual JSON text boundary feeds retained processing. It applies the
same value budgets as `retain`, preserves the parser's last-duplicate-member
policy, and does not produce a native export until requested.

```ts
import { JSONNumber } from "@openbindings/json";
import { bytesValue, recordValue } from "@openbindings/json/values";

const result = recordValue({
  id: new JSONNumber("9007199254740993"),
  metadata: { name: "attachment.bin" },
  content: bytesValue(new Uint8Array([0, 255, 1])),
});
result.get("metadata")!.get("name")!.scalar(); // "attachment.bin"
result.get("content")!.bytes();                // owned byte copy; no Base64
result.get("content")!.byteLength;             // 3; no byte copy
result.get("content")!.length;                 // 4 logical string characters
result.get("id")!.numberToken();               // "9007199254740993"
result.text(); // {"id":9007199254740993,"metadata":{"name":"attachment.bin"},"content":"AP8B"}
```

`native()` returns a detached tree containing supported native bytes; `json()`
returns exact logical JSON values; `text()` serializes that logical projection.
A byte projection is explicitly a Base64 **string**, not another JSON type.
String operations or JSON export can encode it; inspecting metadata cannot.
`costs` exposes immutable counters, including `stringForcingBytes` by reason.
`size()` reports logical node occurrences, scalar/key bytes and native byte
storage without encoding. Repeated shared subtrees count conservatively at each
occurrence. These numbers support admission and queue budgets; they are not a
measurement of process RSS or an assertion about garbage-collection timing.
Schema/evaluator/transport adapters can supply the actual reason to `scalar`,
`json` or `text`; defaults are a string operation or export respectively.

Factories snapshot caller data. `borrowBytes` explicitly observes caller
mutation; `snapshot()` or insertion into a new retained record owns a stable
snapshot. `transferBytes` transfers an entire ArrayBuffer without a byte copy
and detaches **all** source aliases. It rejects slices and pooled buffers before
transfer; use `bytesValue` for a copied slice. Shared/resizable buffers require
external synchronization and are not admitted by these factories.

Extracted child handles survive parent `dispose()` and do not point back to the
parent. Disposal is idempotent; later data reads on the disposed handle fail.
Outputs and byte exports are detached copies. Ordinary garbage collection works
when explicit disposal is omitted; these factories do not own external I/O.

Default admission limits are 512 nesting levels, 1,000,000 nodes and 64 MiB of
scalar/key storage. Callers may set `ValueLimits` explicitly. Whole JSON export
also allocates its encoded representation; the limit is not a process RSS cap.
Data admission rejects cycles, array holes, getters, hooks and undeclared host
objects. Factories and explicit access adapters are host boundaries, not a
sandbox for malicious JavaScript Proxy traps.

Use `retainFrom(value, access)` to import a separately installed implementation
of `ValueAccess` v1. Supply its adapter explicitly, including when crossing an
ESM/CJS package copy. Plain wrapper-shaped objects do not authenticate themselves
as retained values. The [candidate contract](VALUES.md) describes invocation and
evaluator integration; those capabilities have separate owners and qualification.
