# @openbindings/usage

TypeScript invocation, synthesis, and source inspection for the exact
`openbindings.usage@1` binding specification, pinned to jdx usage v3.5.6.

```bash
npm install @openbindings/usage @openbindings/sdk
```

```typescript
import { UsageInvoker, UsageSynthesizer } from "@openbindings/usage";
import { OperationInvoker } from "@openbindings/sdk";

const operations = new OperationInvoker([new UsageInvoker()]);
const authoring = new UsageSynthesizer();
```

Content is pristine usage KDL text. A location is an absolute document URI or
an `exec:` argv address; exec acquisition is denied unless the constructor's
`authorizeExecAddress` approves that exact vector. Refs are exact,
space-separated command paths; omitting the ref selects the root command, and
artifact aliases ride into argv exactly as selected.

The descriptor remains authoritative for field identities, spellings,
globals, arity, defaults, declared environment fallbacks, requirements,
choices, overrides, and delimiter behavior. A non-string value has no invented
token encoding. Named `encode`, `route`, `decode`, `classify`, and `target`
configuration points fill only choices the artifact leaves open. Generic
credentials never ride argv and have no invented environment mapping.

Includes, mounts, configuration-file discovery, and external argument parse
commands are refused in revision 1. The binding specification is normative;
this README describes the package surface and declared coverage.
