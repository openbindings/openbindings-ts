# Retained values — candidate contract v1

This is an additive runtime API. It does not change the Open Bindings document
model, JSON's logical types, numeric policy, JSON Schema validity or wire formats.
The first owner is `@openbindings/json/values`; no invoker, schema or transport is
a dependency. Go implements the same semantics in `jsonvalue` with idiomatic APIs.

## Logical value and physical storage

A value has one logical kind: null, boolean, number, string, array or object.
Absence is a failed member lookup, distinct from a present null. Numbers retain
their assigned decimal token through the existing exact carrier; arithmetic
continues to belong to the evaluator. No implicit conversion through `Number`
is permitted for an exact token. Already rounded source data cannot be repaired.

A declared Base64 string may have a byte buffer as storage. `bytesValue(bytes)`
constructs this projection explicitly; a random Uint8Array passed as JSON is an
admission error. The logical value is still a string. Its length can be known
without encoding; obtaining its characters, matching a pattern or exporting JSON
may encode. Native byte access returns bytes. No wrapper or encoding tag appears
in the logical JSON. Other native object types need explicit future projections; there
is no implicit Date, class instance, file path or URL conversion.

Candidate operations are `retain(value)`, `bytesValue(bytes)`, `recordValue`
and `arrayValue`. A retained handle supplies `kind`, `get(key)`, `keys()`,
`length`, `byteLength`, `size()`, scalar access, `native()`, `json()`, `text()`, `snapshot()` and
`dispose()`. `json()` returns an exact, ordinary logical JSON value; `text()` is
the actual serialization boundary. `native()` returns a detached in-memory
projection, with bytes where that storage is supported. It does not promise the
original transport object's identity. Transport evidence is a separate field on
the invocation record, with an explicit availability reason when absent.

`text()` constructs one serializer-safe projection directly from admitted values
and uses the existing JSON serializer. It does not first produce a public `json()`
view. Arbitrary caller objects still use checked `stringifyJSON` admission; the
private text path adds no public trust option and invokes no inherited hooks.

`get` returns a handle to that member, or undefined for absence; it does not
materialize siblings. Arrays accept nonnegative integer indices and objects
accept exact string keys. Prototype member names are ordinary data. A selected
child retains its own subtree, not a back-reference to the whole result.

## Ownership, admission and resources

Public factories snapshot caller-owned input. Byte snapshots copy only the
supplied slice. Explicit `borrowBytes` observes caller mutations until snapshotted;
the caller must keep the storage available and synchronize mutations. Borrowing
does not claim immutability or asynchronous evaluation stability. Evaluation and
normal invocation own a stable snapshot; they never silently retain a mutable
borrow as an assigned result. An internal native client handoff may adopt a buffer
only when it owns that buffer exclusively and relinquishes further mutation.
TypeScript's explicit `transferBytes` factory enforces that handoff by detaching
all caller aliases; it accepts an entire ordinary ArrayBuffer and refuses slices
or pooled buffers before transfer. Public native exports remain copied.

Native exports copy by default. Explicit disposal releases a handle's references
and makes subsequent reads on that handle fail. Existing child handles survive
parent disposal and ordinary invocation closure. They may be detached explicitly
to avoid retaining a larger backing buffer. Cancellation ends the relevant work,
not every future read on already delivered values. There is no permanent stream
history; records are retained by callers or the bounded delivery queue.

Admission accepts JSON data and authenticated exact numbers. It rejects holes,
cycles, functions, symbols, getters, toJSON hooks and undeclared host objects.
An ordinary object containing `rawJSON` or another marker-shaped property remains
an ordinary object; its fields never authenticate a number, function or handle.
Descriptor inspection does not invoke getters. JavaScript has no portable way
to identify an arbitrary transparent Proxy without invoking its traps: factories
are a host-data boundary, not a sandbox for hostile host objects. Expressions
cannot supply executable accessors or forge internal handles. A registered
ValueAccess adapter is explicitly trusted host code, never obtained from a JSON
document. No implicit fetch, file read, service invocation or native callback is
authorized by a value lookup.

Admission, traversal, serialization and evaluation have bounded depth, node and
byte budgets. Capability or resource failure is explicit, never replaced by a
lower-fidelity value. Counters separately report node access, byte copies, Base64
work and JSON serialization; inspection of counters does not force values.

## Evaluator boundary

The value package owns a versioned structural access protocol, with logical kind,
exact number token, scalar, key/index and optional native-byte access. The caller
passes the adapter explicitly to an evaluator. This allows independently installed
copies and different storage implementations without recognizing a user object's
property as an authenticity brand. JSONata depends on this protocol's declared
shape, not on Core, invocation or the TypeScript package's private classes.

`ValueAccess.copyBytesInto(value, destination)` is an optional trusted adapter
capability. The receiver validates byte/logical lengths and its budget before
allocating an exact-size destination. The sender copies into that destination,
returns its length (including zero), and must never retain or expose it. Only an
own data-property function is negotiated; inherited properties and getters use
the existing defensive `bytes()` snapshot path. Missing byte metadata also keeps
that older path. A failed or short copy is terminal and never triggers a retry.

The official adapter charges the physical copy to the sender exactly once. A
new SDK/owner pair therefore copies N bytes per bridge direction; receiver
allocation is not a second copy. Older combinations still work through snapshots.
This is a trusted host contract, not a sandbox for malicious adapter code. Public
`bytes()` and `native()` exports remain independent mutable copies, and borrowed
input is snapshotted when captured. No Base64 or JSON text is needed by this seam.

The JSONata repository owns parsing, complete evaluation, selected planning,
numeric behavior and context caches. The SDK does not parse or interpret JSONata.
The existing text executor stays available, including isolated workers. Capability
discovery reports whether complete retained and selected execution are available;
a worker fallback reports its text boundary and preserves the selected isolation.

Complete value execution uses the existing language evaluator. It preserves the
existing result-domain and error contract, and does not serialize its input or
output simply to cross an SDK interface. A string operation on a byte-backed
string may force that string. Opaque native storage cannot change string equality,
ordering, truthiness, length, object membership or `$type`.

Selected evaluation belongs to an explicit evaluation context and reports partial
status. Fixed object fields, paths and arithmetic are mandatory optimized cases.
Unsupported plans use a truthful complete fallback, with its cost and errors.
Scope, input identity, position, bindings, options and dynamic assignments belong
to the context. Concurrent/repeated reads share only semantically identical work;
one cancelled waiter does not cancel another. Completion checks all required
branches and the full result domain. Disposal releases context caches.

## Invocation and validation

An invocation occurrence has stable invocation/attempt/sequence identity and
separate native evidence, pre-transform logical value and transformed value.
No-transform stages may share immutable storage while keeping their stage labels.
Retry attempts never overwrite each other's evidence. Inputs retain corresponding
before/after stages and pass required validation before a native side effect.

Normal delivered output remains completely transformed and validated. Its default
retained value and JSON export are post-transform. A selected read is a separate
API and never an ordinary successful frame. An invocation that requests selected
evaluation must use that explicit contract before ordinary eager completion; merely
reading a field from an already completed result cannot undo prior work.

The existing schema backend owns traversal, references, applicators and annotation
bookkeeping. Native-aware scalar predicates may avoid encoding (for example string
type or Base64 length). Regex, string const/enum and diagnostics may force text.
A backend that cannot consume a retained operation uses a declared full logical
projection. Partial traversal is never reported as complete validation.

## Counterexamples and required results

| Case | Required result |
| --- | --- |
| `9007199254740993` through input, transform, schema and JSON export | Same numeric value, never a quoted carrier object or rounded number |
| `0.1 * 3` | `0.3` under the existing numeric policy |
| Missing `x` versus `{x:null}` | Absent lookup versus present null handle |
| Mutate source bytes after owned capture | Captured value unchanged |
| Mutate explicitly borrowed bytes | Borrowed view observes change; snapshot remains stable |
| Dispose parent after extracting a small child | Child remains readable without retaining parent containers |
| Read metadata beside a large attachment | Zero Base64 work and zero whole-value JSON serialization |
| Transform `{total: a*b, unused: $error("unused")}` then select total | Selected total succeeds; complete evaluation fails |
| Emit that selected total as a normal validated output | Rejected by API/type boundary |
| Two evaluations of the same AST with different lexical input | No result cache collision |
| JSON export after a successful transform | Export the transformed value, not pre-transform storage |
| Choose a text-only worker | Preserve worker isolation; report required serialization |
| Pass an object with an accessor or an undeclared host wrapper | Reject without executing the getter or a serialization hook |
| Pass a plain object shaped like a numeric wrapper | Treat it as an object, never as an authenticated number |
| A caller retains a result after transport closure | Reads work without re-invoking the service |

The user narrowed this run to foundations, OpenAPI and consumers above bindings.
Other binding implementations remain unchanged; shared APIs are additive for their
compatibility. No candidate contract implies a release, registry publication or
adoption of unfinished gRPC/AsyncAPI specifications.

Node import and require of the same installed `/values` entry share one private runtime owner. Browser conditions keep a native ESM entry. Separate installations still require an explicit `ValueAccess` import; no global brand or registry authenticates a foreign value.

## Owned, deferred logical strings

For ordinary callers, use `base64(bytes)` for canonical Base64, or
`encodedString(bytes, encoding)` for a third-party representation. Both own a
copy; neither constructs the encoded string at creation. `bytesValue` remains
supported with its existing Base64 meaning.

```ts
import * as json from "@openbindings/json/values";
import { createJSONataValueExecutor } from "@openbindings/jsonata";

const bytes = new Uint8Array([251, 255]);
const base64 = json.base64(bytes);
base64.native(); // owned Uint8Array copy; no encoding
base64.json();   // "+/8=" (logical JSON value)
base64.text();   // '"+/8="' (JSON text)

// Entirely application-owned. No registration or evaluator changes.
const hex: json.StringEncoding = {
  length: bytes => bytes.length * 2,
  encode: bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""),
};
const input = json.encodedString(bytes, hex);
const evaluator = createJSONataValueExecutor();
const passed = await evaluator.evaluate("$", input, json.retainedValueAccess);
const output = json.retainFrom(passed.value, passed.access);
passed.dispose();
input.dispose();
output.native(); // Uint8Array([251, 255]); hex.encode has not run
output.json();   // "fbff"
output.text();   // '"fbff"'

const changed = await evaluator.evaluate("$uppercase($)", output, json.retainedValueAccess);
const upper = json.retainFrom(changed.value, changed.access);
upper.json();   // "FBFF"
upper.native(); // "FBFF": the expression created a new string
changed.dispose();
upper.dispose();
output.dispose();
base64.dispose();
```

Compose values with `retain({data: input, ...})`, read children with `get`, and
request `json`, `text`, or `native` only when needed. The supplied
`retainedValueAccess` is the bridge to independent evaluators; callers do not
implement it. Disposal releases that handle. Extracted children and captured
results survive disposal of their source.

`StringEncoding.length` declares the exact Unicode code point count. `encode`
must produce that logical string deterministically. Each callback receives a
disposable copy, so mutating it cannot mutate the retained backing. Functions
must not depend on `this`, mutable captured state or source data graphs. They
are trusted application code, not serialized document content or a sandbox.
The library retains the encoder function, but not the encoding object, length
callback, source accessor or source copy callback.

The optional `ValueAccess.deferredString` capability transports byte length,
logical length, a detached encoder, and a synchronous copy operation. Receivers
budget native bytes plus four bytes per logical code point **before allocating
the destination**, own the copied storage, and verify the string's actual length
when forced. Factory admission applies the same bound after the length callback;
it first bounds native storage. Temporary callback allocations/execution time
cannot be enforced in-process. An invalid advertised capability fails closed;
an absent capability uses ordinary logical scalar fallback.

Six JSON kinds remain unchanged. JSONata string operations observe the logical
characters. Pass-through and metadata can preserve backing without encoding;
string-changing operations return the resulting logical value, with no invented
native inverse. Equality across representations falls back to logical strings.
Only the privately recognized built-in canonical Base64 representation takes
Base64 native shortcuts. Legacy `byteLength`, `bytes`, and `copyBytesInto` access
capabilities remain **Base64-only**; `native()` is the general public native view.
Older consumers that lack the extension correctly force a logical string.
Schema validation currently uses that safe eager fallback for custom encodings.

This seam handles owned byte-backed strings only. It adds no codec registry,
resource-handle framework, inverse decoder, implicit wire encoding, or external
resource disposal callbacks. The binding specification still defines protocol
correspondence; the client engine still implements encoding and decoding.
