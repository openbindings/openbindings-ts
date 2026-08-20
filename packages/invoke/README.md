# @openbindings/invoke

The OpenBindings invocation layer: the binding-invoker and operation-invoker
pattern. Invocation handles, error codes, invocation context and the context
store seam, consumer hooks, operation signatures, and operation requirements.

```ts
import { OperationInvoker, operationSignature } from "@openbindings/invoke";
```

Depends only on
[`@openbindings/core`](https://www.npmjs.com/package/@openbindings/core) and
[`@openbindings/compare`](https://www.npmjs.com/package/@openbindings/compare) —
no third-party runtime dependencies. Binding-spec invokers (for example
`@openbindings/openapi`) implement the interfaces published here;
[`@openbindings/sdk`](https://www.npmjs.com/package/@openbindings/sdk) is the
facade re-exporting this package alongside its siblings.

See the [OpenBindings documentation](https://openbindings.com) and the
[repository README](https://github.com/openbindings/openbindings-ts) for the
full picture.

## License

Apache-2.0
