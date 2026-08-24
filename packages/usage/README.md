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
`authorizeExecAddress` approves that exact vector. Selectors are exact,
space-separated command paths; omitting the selector selects the root command, and
artifact aliases ride into argv exactly as selected.

The descriptor remains authoritative for field identities, spellings,
globals, arity, defaults, declared environment fallbacks, requirements,
choices, overrides, and delimiter behavior. A non-string value has no invented
token encoding. Named `encode`, `route`, `decode`, `classify`, and `target`
configuration points fill only choices the artifact leaves open. Generic
credentials never ride argv and have no invented environment mapping.

A rejected exit, signal termination, or post-process decode failure is
terminal rather than an operation output. Its `usage.process` evidence retains
exit/signal identity, exact stdout/stderr bytes, and truncation markers;
`usageFailureEvidence` validates and extracts it. Successful stderr remains
metadata through the Base64 `x-stderr-base64` trailer lane.

Includes, mounts, configuration-file discovery, and external argument parse
commands are refused in revision 1. The binding specification is normative;
this README describes the package surface and declared coverage.
