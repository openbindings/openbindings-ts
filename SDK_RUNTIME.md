# SDK runtime architecture

`OpenBindingsRuntime` is the optional protocol-neutral composition root above
the published Core, invocation, synthesis, and inspection contracts. It owns
an explicit, instance-scoped set of binding providers. It installs no global
registry and imports no binding implementation.

For OpenAPI, one `OpenAPIAdapter` implements `BindingInvoker`,
`CoverageSynthesizer`, and `SourceInspector`. The adapter delegates OpenAPI
loading, declaration analysis, request construction, HTTP, response handling,
and streams to `@openbindings/openapi-client`; it translates only OpenBindings
contracts and lifecycle.

The dependency rule is strict:

```text
application / OB CLI
  -> OpenBindingsRuntime
     -> protocol-neutral contracts
        -> OpenAPIAdapter
           -> standalone OpenAPI client and provider projection
```

The runtime may resolve or synthesize an interface, inspect a source, prepare
an operation, and invoke it. Its `invoke` method accepts either a dynamic
operation key or a generated typed signature; `operationInvoker` remains
available for lower-level composition. Duplicate exact identifiers listed by
the registered providers are rejected at construction; registration order
never silently chooses between competing listed implementations. As in the
underlying contracts, `bindingSpecs()` is discovery metadata while
`checkBindingSpecs()` remains authoritative for dynamic support.

Retrieval and transport policy remain explicit at their owning boundaries.
The runtime's `fetch` retrieves OBIs and is also passed to binding invocation;
`OpenAPIAdapter({ fetch })` controls synthesis and inspection reads. A host
that supplies a restricted fetch implementation normally passes it to both.
The two settings are separate because authoring reads and live API dispatch
can require different security policies.

The lower-level packages remain first-class. A library may import only
`@openbindings/core`, `@openbindings/invoke`, or `@openbindings/synthesize`,
and a binding implementation remains independently usable without the facade.
OB CLI owns the concrete list of installed binding packages and is migrated
only after this SDK boundary passes independently.
