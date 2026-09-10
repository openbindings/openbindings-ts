# Private validator dependency correction

The shared `@openbindings/json-schema` adapter uses **json-schema-library 11.6.2**,
with a version-specific pnpm patch. Core and the standalone OpenAPI client use
that adapter; the adapter has no OpenBindings Core dependency.
This is an upstream backend plus a bounded correction, not an OpenBindings
validator implementation or a new specification requirement. Public backend
types, reference resolution and schema compilation interfaces are unchanged.

The patch fixes annotation/error discrimination, conditional branch selection,
speculative evaluation isolation, scan-local coverage/reference reuse, and
boolean `contains` occurrence counts with dialect-correct count semantics. It
assumes stable schema, instance and registry data during synchronous validation.
It does not promise stateful custom-validator call counts or async validation.

## Consumer delivery

The validator is pinned and privately bundled into both shared adapter entry
points by tsup. Its dependency declaration also supplies the upstream public
TypeScript types. Runtime calls use the corrected bundled evaluator, not the
unpatched dependency entry point. Consumers need neither pnpm nor patch
configuration. `THIRD_PARTY_NOTICES.md` accompanies the adapter artifact.
Do not revert it to an external runtime dependency until an unpatched upstream
release passes the retained regression and qualification gates.

## Provenance and reproduction

- Upstream: <https://github.com/sagold/json-schema-library>
- npm version: `11.6.2`; upstream git head:
  `65578c185fc324ebf8fcc8f6e654e85cbfab4da8`
- npm integrity:
  `sha512-BwvoJfc6RNrYRxQ9AujaTMaLdQosdceRe0huKMnnIJa2b4QZlnmPgQm7iUMoyxS2ioTsTMVPWjuoqvFYF0HZ4Q==`
- `source.patch` is the readable source/test correction. The pnpm patch also
  contains rebuilt public ESM/CJS entries; upstream declaration files remain
  unchanged. `build.json` records source and output hashes.

Use pnpm 10.15.0 and the frozen repository lockfile. To verify an install:

```sh
pnpm install --frozen-lockfile
node scripts/validator-dependency.mjs verify
```

To regenerate, use `pnpm patch json-schema-library@11.6.2 --ignore-existing
--edit-dir <directory>`, apply `source.patch` there, run
`node scripts/validator-dependency.mjs build <directory>`, then use
`pnpm patch-commit <directory>`. The builder is pinned to esbuild 0.28.1. Do not
edit node_modules or rely on install lifecycle scripts to repair a release.

## Upgrade/removal gate

Keep the correction pinned until an upstream replacement passes all retained
branch/annotation/reference controls, all five mandatory JSON Schema draft
suites, browser/CSP and packed ESM/CJS consumer checks, and the bounded shape
and reference performance gates. Exact-number adaptation has its own gate;
successful dependency adoption is not numerical-fidelity qualification.

## Continuation qualification

The boolean-count counterexamples are now corrected in the maintained patch.
Both installed public entry points pass the retained 4,950 mandatory draft
cases; the production shared exact adapter passes the 1,657 retained numeric
decisions. `pnpm validator:qualify` retains the 55 regression controls and 244
expanded contains/count cases. These are component results, not a release gate:
the assembled exact-carriage candidate still requires final package, runtime,
integration, resource and performance qualification. JSONata is not qualified
for the new carrier by these results.

Upstream contribution is desirable but is a separate external action. An
upstream issue or PR is not evidence that a published version includes a fix.
