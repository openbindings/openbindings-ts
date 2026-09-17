# Exact JSON with retained values

`@openbindings/json` works independently of OpenBindings. Use ordinary objects,
arrays, and the six JSON types, with two explicit rich leaves: `Decimal` for exact
numbers and `Encoded` for logical strings with owned byte backing. No global JSON
methods or prototypes are changed.

This is prerelease source. Install the coordinated local package archives supplied
by your build; no public npm release is implied by these examples. The public API
supports Node 18+ and modern browsers through a module bundler.

```ts
import * as json from "@openbindings/json";

const data = json.parse('{"id":9007199254740993,"price":0.10}');
String(data.id);       // "9007199254740993"
String(data.price);    // "0.10": retained token spelling
json.stringify(data); // {"id":9007199254740993,"price":0.10}

const file = json.base64(Uint8Array.of(0, 1, 254, 255));
file.byteLength;       // 4
file.length;           // 8 logical Unicode code points
file.bytes();          // a new byte copy; no encoding
String(file);          // "AAH+/w==": encodes once, then caches the string
json.stringify({ file }); // {"file":"AAH+/w=="}
```

## Interoperation

| You need | Use | What to expect |
| --- | --- | --- |
| Portable exact JSON text | `json.stringify(value)` | Use `json.parse` to read exact numbers back. |
| A retained string's characters | `String(encoded)` | Materializes once when needed, then caches. |
| Native byte backing, when available | `json.bytes(value)` | A mutable copy, or `undefined`; never decodes strings. |
| Logical value equality | `json.equal(a, b)` | Rich-leaf `===` compares identity. Equality is not admission validation. |
| Exact JavaScript numeric conversion | `json.toNumber(n)` | Throws if binary64 would round the value. |
| Deliberately rounded numeric conversion | `json.toNumber(n, { lossy: true })` | Explicitly accepts binary64 rounding. |
| Primitive data preserving decimal digits | `json.plain(value, { numbers: "token" })` | Decimal values become strings where needed, changing their types. |
| Primitive data accepting numeric rounding | `json.plain(value, { numbers: "lossy" })` | A mutable tree with explicitly rounded numbers. |

`base64(bytes)` takes an owned byte copy and defers encoding. JSON text carries
the logical string, not its backing: parsing it does not reconstruct native bytes.
Transforms that change a string may return an ordinary string without backing;
the JSONata worker also uses a text boundary. Share one codec installation when
passing rich leaves between packages; the advanced adapter imports foreign ones.
Generic parse/evaluation types are caller assertions, not runtime validation.

## Numbers and conversion

Safe integers are JavaScript numbers. Other finite decimal values are `Decimal`
objects. `number(token)` applies the same rule; `parse` preserves exact decimal
values instead of first rounding them to binary64. Safe-integer spellings such as
`1.0` normalize to `1`, and `-0` normalizes to `0`. Native numbers already rounded
by the caller cannot recover their original digits.

`Numeric` is `number | Decimal`. `String(n)` prints either. A Decimal refuses
implicit arithmetic, `Number(n)`, and loose numeric equality with
`ERR_JSON_COERCION`. Use JSONata for exact arithmetic, or explicitly convert:

```ts
json.toNumber(json.number("0.5"));                // 0.5: exactly representable
json.toNumber(json.number("0.1"));                // throws ERR_JSON_INEXACT
json.toNumber(json.number("0.1"), { lossy: true }); // 0.1: intentional rounding
```

`===` compares rich-leaf identity. `json.equal(a, b)` compares logical values,
ignoring object member order. Numeric comparisons beyond the current work limits
(4,096 token characters, explicit exponent magnitude 10,000) can throw
`ERR_JSON_BUDGET`; identical tokens need no such comparison work.

## Logical representation and native backing

`base64(bytes)` declares a Base64 logical string; it does not encode immediately.
It snapshots the caller's bytes. `bytes()` always returns a new copy; mutating the
source or an exported copy cannot change the value. The following adapter adds
hexadecimal without modifying this library or an evaluator:

```ts
const hex = Object.freeze({
  length: (bytes: Uint8Array) => bytes.length * 2,
  encode: (bytes: Uint8Array) =>
    Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""),
} satisfies json.Encoding);

const value = json.encoded(Uint8Array.of(251, 255), hex);
value.bytes();                          // [251, 255], copied without encoding
value.encoding === json.BASE64;         // false
String(value);                          // "fbff"
json.stringify({ value });              // {"value":"fbff"}
json.bytes("fbff");                     // undefined; this helper never decodes
```

Encoders are trusted, deterministic, receiver-independent functions. `length`
reads the caller's byte array before the snapshot and must report the logical
code-point length. A custom `encode` receives a disposable copy, never owned
storage. Its result length is checked; failure is remembered and the callback
is not retried. Adapter transient allocations and execution time are not sandboxed.
When an adapter reuses `BASE64.encode`, its declared length is checked against
the known Base64 length at construction, without encoding or copying bytes first.

Equality can inspect bytes without producing characters when that proves the
answer. Arbitrary encodings need not be injective: different bytes may denote
the same string, so custom or cross-representation comparisons may encode.
Native byte access is always available on an Encoded. A protocol shortcut needs
an additional compatibility check such as `value.encoding === json.BASE64`;
bytes alone do not determine their logical representation or a wire protocol.

## Values, plain projections, and JSON text

- The rich value contains ordinary containers and the two leaf classes.
- `String(encoded)` reads its logical JSON string; `encoded.bytes()` reads copied
  native backing. Neither changes its meaning.
- `json.stringify(value, space?)` writes complete JSON text in insertion order.
  It never invokes arbitrary `toJSON` hooks and rejects invalid JSON data.
- `json.plain(value, { numbers })` makes a mutable primitive projection. Choose
  `"throw"` (default: exact binary64 conversion or an error), `"token"` (numbers become text where
  needed), or `"lossy"` (explicit binary64 conversion). These choices have
  different types/fidelity; a primitive projection is not universally lossless.

`json.stringify` is the portable exact serialization path. Native `JSON.stringify`
also writes exact Decimal tokens when its host supports the actual rawJSON token
format (for example Node 22). Otherwise Decimal serialization throws
`ValueError` with `code: "ERR_JSON_COERCION"` and
`details.reason: "native-raw-json-unavailable"`; it never silently emits an
object instead of a number. Encoded native serialization remains a normal string.
Caller-supplied replacers and modified global serializers are outside this
intrinsic-serializer guarantee. Native `JSON.parse` can still round the resulting
text; use this package's parser when exact values matter.

## Types, errors, and ownership

`parse<T = any>` defaults to `any`, like native JSON.parse. A supplied `T` is an
unchecked assertion, not schema validation. You can request `Value` and narrow it:

```ts
const value: json.Value = json.parse<json.Value>("0.1");
if (json.isDecimal(value)) console.log(String(value));
```

Parse output is mutable. Encoded and Decimal leaves are immutable. JSONata results
are deeply frozen and can be reused; reuse can still traverse containers for
budget accounting. After first encoding, both native bytes and cached text can
remain until garbage collection. Ordinary values require no explicit disposal.

Admission rejects non-finite numbers, undefined members, cycles, sparse arrays,
accessors, functions, and undeclared host objects rather than silently changing
them. Library value errors expose stable `ValueError.code` values:
`ERR_JSON_SYNTAX`, `ERR_JSON_ADMISSION`, `ERR_JSON_BUDGET`,
`ERR_JSON_INEXACT`, and `ERR_JSON_COERCION`. Host failures and caller code are not
promised to become a coded library error. Limits bound library admission work and
storage accounting, not process RSS or garbage-collection timing.

## Advanced and compatibility interfaces

Ordinary use needs no `ValueAccess`. `@openbindings/json/advanced` exposes
`external(root, access)`, `sizeOf`, `counters`, and numeric `compare` for foreign
stores and instrumentation. Leaf authentication is private to one installation;
import a foreign installation's values with its access adapter rather than a
forged marker. The root, advanced, and internal entries share one runtime for
Node import/require and browser module consumers. `internal` is unsupported.

Older names and the `/values` handle API remain available; see [LEGACY.md](LEGACY.md)
and [VALUES.md](VALUES.md). Their disposal and representation contracts belong to
those legacy APIs. No OpenBindings document, invoker, or binding is required here.
