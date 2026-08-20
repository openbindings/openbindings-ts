# @openbindings/synthesize

The OpenBindings synthesis layer: the interface-synthesizer and
source-inspector pattern. Synthesize OBIs from binding sources, account for
coverage with durable evidence, combine synthesizers and inspectors, fetch
interfaces from URLs (with well-known discovery and synthesis fallback), and
run portable synthesis scenarios.

```ts
import { fetchInterface, combineSynthesizers } from "@openbindings/synthesize";
```

Depends only on
[`@openbindings/core`](https://www.npmjs.com/package/@openbindings/core).
Binding-spec synthesizers (for example `@openbindings/openapi`) implement the
interfaces published here;
[`@openbindings/sdk`](https://www.npmjs.com/package/@openbindings/sdk) is the
facade re-exporting this package alongside its siblings.

See the [OpenBindings documentation](https://openbindings.com) and the
[repository README](https://github.com/openbindings/openbindings-ts) for the
full picture.

## License

Apache-2.0
