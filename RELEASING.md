# Releasing openbindings-ts

This is a pnpm workspace monorepo. All nine packages under `packages/`
(`sdk`, `openapi`, `asyncapi`, `graphql`, `mcp`, `grpc`, `connect`, `usage`,
`operationgraph`) version in lockstep: a single **annotated** `vX.Y.Z` tag
covers every package.

## Flow

1. Verify the `version` field in every `packages/*/package.json` reads
   `X.Y.Z` (in practice the fields are bumped when the working-draft
   changelog section opens, so this is a check that all nine agree, not
   an edit).
2. Retitle the `## X.Y.Z (working draft)` section in `CHANGELOG.md` to
   `## X.Y.Z — YYYY-MM-DD`, where the date is the tag date.
3. Tag (annotated, never lightweight) and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "openbindings-ts vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Push the annotated tag. `.github/workflows/publish.yml` takes it from
   there: full build, lint, and the test suite in corpus-required mode,
   then `pnpm -r publish --access public --provenance` over npm trusted
   publishing (OIDC) — no long-lived token exists anywhere. Every
   published tarball carries an npm build-provenance attestation.

   `--access public` is also persisted in each package's
   `publishConfig.access`, and each package's `prepack` script reruns its
   build, so a publish can never ship a missing or stale `dist`. pnpm
   publishes in topological order, so the layered SDK packages
   (`@openbindings/core`, then `@openbindings/compare`,
   `@openbindings/invoke`, and `@openbindings/synthesize`) land on the
   registry before the `@openbindings/sdk` facade and the format packages
   that depend on them.

One-time setup before the first tagged publish: on npmjs.com, each
`@openbindings/*` package must list this repository and
`.github/workflows/publish.yml` as its trusted publisher. If the OIDC
exchange is ever unavailable, the documented fallback is a manual
`pnpm -r build && pnpm -r publish --access public` from a clean tag
checkout — but the workflow is the canonical path.

## Spec compatibility

`@openbindings/core` declares which spec versions it supports via
`MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION` (and `supportedRange()` /
`isSupportedVersion(v)`), exported from `packages/core/src/version.ts` and
re-exported by the `@openbindings/sdk` facade.
When the spec version bumps, update these constants in the same PR that
adds support for the new version.

## Pre-1.0 policy

Minor versions may include breaking changes; patch versions are for bug
fixes and non-breaking changes. Breaking changes are documented in
`CHANGELOG.md` under **Changed** or **Removed**.

## Historical note

These conventions apply from 0.2.0 on. The v0.1.0 release predates them:
its tag is lightweight, and its changelog heading is dated 2026-03-31
while the tag commit is dated 2026-04-15. Both stand as released.
