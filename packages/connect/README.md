# @openbindings/connect

TypeScript invocation, synthesis, and source inspection for the exact
`openbindings.connect@1` binding specification.

```bash
npm install @openbindings/connect @openbindings/sdk
```

```typescript
import { ConnectInvoker, ConnectSynthesizer } from "@openbindings/connect";
import { OperationInvoker } from "@openbindings/sdk";

const operations = new OperationInvoker([new ConnectInvoker()]);
const authoring = new ConnectSynthesizer();
```

The source location is an HTTP(S) service base URL. Embedded content is
single-file proto text or a canonical-JSON `FileDescriptorSet` and enables
schema mode: byte-exact selector resolution, canonical ProtoJSON, and the
protobuf-declared interaction kind. Without content, descriptorless mode is
unary and carries exactly one JSON value verbatim. Because Connect provides no
reflection lane, synthesis and source inspection require content rather than
inventing a method set.

Schema-mode synthesis uses the same directional ProtoJSON projection as the
gRPC package: input aliases and null-unset semantics, canonical output names,
recursive `$defs`/`$ref`, exact `oneof` constraints, declared map value/key
shapes, base64 bytes, and precision-preserving 64-bit string forms.

Refs are exact `package.Service/Method` names. Unary uses `application/json`;
streaming uses Connect envelopes and an END_STREAM verdict. The protocol's
classification is authoritative. Explicitly named leading metadata may be
configured, but the binding invents no bearer/basic/API-key carriage.

Successful message values remain outputs even when error-shaped. Non-200 and
END_STREAM failures preserve the complete Connect error object and exact
response or envelope bytes; `connectFailureEvidence(error)` exposes them as a
typed API. Streaming outputs emitted before a later error remain visible, and
END_STREAM metadata is available through the invocation trailer.

The binding specification is normative; this README describes the package
surface and declared implementation coverage.
