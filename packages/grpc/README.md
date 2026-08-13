# @openbindings/grpc

TypeScript invocation, synthesis, and source inspection for the exact
`openbindings.grpc@1` binding specification.

```bash
npm install @openbindings/grpc @openbindings/sdk
```

```typescript
import { GrpcInvoker, GrpcSynthesizer } from "@openbindings/grpc";
import { OperationInvoker } from "@openbindings/sdk";

const operations = new OperationInvoker([new GrpcInvoker()]);
const authoring = new GrpcSynthesizer();
```

A source location is a port-explicit dial address: `grpc://host:port`,
`grpcs://host:port`, or bare `host:port`. A bare address supplies no transport
default; configure `transport: "plaintext" | "tls"` explicitly. Content, when
present, is single-file proto source text (only bundled `google/protobuf/*`
imports) or a canonical-JSON `FileDescriptorSet`; it displaces reflection.
Without content, the implementation tries reflection v1 and falls back to
v1alpha only on `UNIMPLEMENTED`.

Refs are exact `package.Service/Method` names. All four protobuf-declared
interaction kinds use one cardinality-agnostic invocation handle. Input and
output values follow canonical ProtoJSON, including well-known types, nested
unknown-field refusal, and precision-preserving 64-bit strings.

Synthesized schemas are directional rather than one shared approximation:
inputs admit ProtoJSON field-name aliases and `null`'s unset-field meaning,
while outputs use canonical JSON names and printer forms. Recursive message
graphs use `$defs`/`$ref`, `oneof` groups carry null-aware at-most-one
constraints, map values use their declared value type with key-shape
constraints, bytes use the accepted base64 spellings, and 64-bit values keep a
full-range string carriage while limiting number values to the interoperable
exact-integer range.

The binding invents no authentication convention. Supply explicitly named
gRPC metadata. Generic credentials without a named carriage raise
`CONTEXT_REQUIRED` before reflection or method dispatch.

Response messages remain outputs even when their fields look error-shaped. A
non-OK final gRPC status terminates the invocation without retracting earlier
messages. Its numeric code, description, rich `google.protobuf.Any` details,
and leading/trailing metadata remain below the abstract invocation boundary;
they do not become operation values or failure data.

The binding specification is normative; this README describes the package
surface and declared implementation coverage.
