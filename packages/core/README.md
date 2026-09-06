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
invocation. It validates a private RFC 8785 snapshot, assigns a SHA-256 content
revision, builds canonical operation/dependency/binding indexes, memoizes exact
boundary-contract identities, and shares compiled operation schemas:

```ts
const prepared = await prepareInterface(iface);
const dependency = prepared.dependency("delivery");
console.log(prepared.revision, dependency?.operation.canonicalKey);
```

Preparation never mutates or retains caller-owned objects and never fetches
external schema resources implicitly.

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
