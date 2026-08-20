# @openbindings/compare

The OpenBindings schema-comparison layer: interface and operation
compatibility checking under the published schema-comparison profile
(OB-2020-12), including the schema normalizer the profile is realized on.

This is a tooling convention, not a spec requirement: the OpenBindings
specification leaves matching, comparison, and selection to tools.

```ts
import { checkInterfaceCompatibility } from "@openbindings/compare";
```

Depends only on
[`@openbindings/core`](https://www.npmjs.com/package/@openbindings/core).
[`@openbindings/sdk`](https://www.npmjs.com/package/@openbindings/sdk) is the
facade re-exporting this package alongside its siblings.

See the [OpenBindings documentation](https://openbindings.com) and the
[repository README](https://github.com/openbindings/openbindings-ts) for the
full picture.

## License

Apache-2.0
