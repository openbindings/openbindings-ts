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
