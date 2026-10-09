# Legacy TypeScript SDK transition

The maintained OpenBindings reference SDK is [openbindings/sdk](https://github.com/openbindings/sdk). Its current engine is Rust, with a TypeScript facade over the same semantics. The independent [OpenAPI client](https://github.com/openbindings/openapi-client) remains a separate library.

This repository retains its history, tags, releases and current compatibility paths while project consumers migrate. New SDK feature work moves to the canonical repository. Necessary transitional repairs may still land here when their consumer need and validation are recorded. Normative meaning remains owned by the OpenBindings specification.

The Rust foundation covers core document semantics, exact JSON, authoring, names/references, explicit value evaluation and optional HTTP discovery. Invocation, synthesis and binding adaptation are separate work. Read the successor's capability and migration guides before replacing an existing caller. Rust-backed Cargo/npm packages are currently unpublished; the existing registry package is not the new Rust-backed facade.

Public archival is a later decision after active application, build, test and release dependencies move and preservation is verified. Repository privacy and historical package retirement are separate decisions. This notice does not retire a consumer capability or change a published version.
