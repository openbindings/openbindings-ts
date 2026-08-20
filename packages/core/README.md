# @openbindings/core

The OpenBindings core layer: everything defined by the OpenBindings
specification itself — the document model, parsing, validation, operation
resolution, dereferencing, canonical JSON, URI handling, spec-version
support, and verification conclusions. Nothing in this package requires
invocation.

```ts
import { parseDocument, validateInterface, resolveOperation } from "@openbindings/core";
```

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
