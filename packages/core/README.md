# @openbindings/core

The OpenBindings core layer: everything defined by the OpenBindings
specification itself — the document model, parsing, validation, operation
resolution, dereferencing, canonical JSON, URI handling, spec-version
support, and verification conclusions. Nothing in this package requires
invocation.

```ts
import { parseDocument, validateInterface, resolveOperation } from "@openbindings/core";
```

`prepareInterface` creates the reusable semantic form used by composition and
invocation. The adopted 2026-09-08 architecture requires one exact, detached
working snapshot, ownership-local caches and optional JCS export. Preparation
must not require a JCS representation; fingerprints cannot erase distinctions
when deciding boundary equality or cache reuse. Boundary graphs retain authored
schema structure, array order, presence and reachable resource content; they
are not the comparison profile's normalized schema identity.

The candidate implements that separation: `snapshotId` is local correlation,
not content equality. `exportJCS()` is optional and throws if canonicalization
would change a retained value; a failed export leaves the snapshot usable.
Use `compareBoundaryContracts` for exact authored-boundary evidence, not IDs.
Successful comparisons between immutable owners may be reused internally.
These implementation commitments do not add Core/binding conformance rules or
qualify JSONata. Shared evaluator-dependent activation remains a separate gate.

The prepared layer builds canonical operation/dependency/binding indexes and
shares compiled operation schemas:

```ts
const prepared = await prepareInterface(iface);
const dependency = prepared.dependency("delivery");
console.log(prepared.snapshotId, dependency?.operation.canonicalKey);
// Only when an explicit canonical export is needed; handle export failure:
const { canonical, revision } = await prepared.exportJCS();
```

Preparation never mutates or retains caller-owned objects and never fetches
external schema resources implicitly.

Go/TypeScript consumers must retain the neutral JSON carriers at ordinary data
boundaries. In TypeScript use `@openbindings/json` (also re-exported by the SDK
facade) for parsing, encoding and copying values. Node import/require entries
share an owner runtime; browser-condition exports use native ESM.

The layered packages build on it:

- [`@openbindings/invoke`](https://www.npmjs.com/package/@openbindings/invoke) — the binding-invoker / operation-invoker pattern
- [`@openbindings/synthesize`](https://www.npmjs.com/package/@openbindings/synthesize) — the interface-synthesizer / source-inspector pattern
- [`@openbindings/compare`](https://www.npmjs.com/package/@openbindings/compare) — schema comparison under the published OB-2020-12 profile
- [`@openbindings/sdk`](https://www.npmjs.com/package/@openbindings/sdk) — the facade re-exporting all four

See the [OpenBindings documentation](https://openbindings.com) and the
[repository README](https://github.com/openbindings/openbindings-ts) for the
full picture.

## License

Apache-2.0
