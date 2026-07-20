# Releasing openbindings-ts

This is a pnpm workspace monorepo. All seven packages under `packages/`
(`sdk`, `openapi`, `asyncapi`, `graphql`, `mcp`, `operationgraph`,
`workers-rpc`) version in lockstep: a single **annotated** `vX.Y.Z` tag
covers every package.

## Flow

1. Verify the `version` field in every `packages/*/package.json` reads
   `X.Y.Z` (in practice the fields are bumped when the working-draft
   changelog section opens, so this is a check that all seven agree, not
   an edit).
2. Retitle the `## X.Y.Z (working draft)` section in `CHANGELOG.md` to
   `## X.Y.Z — YYYY-MM-DD`, where the date is the tag date.
3. Tag (annotated, never lightweight) and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "openbindings-ts vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Build and publish:

   ```bash
   pnpm -r build
   pnpm -r publish --access public
   ```

   `--access public` is also persisted in each package's
   `publishConfig.access`, and each package's `prepack` script reruns its
   build, so a publish can never ship a missing or stale `dist`. pnpm
   publishes in topological order, so `@openbindings/sdk` lands on the
   registry before the format packages that depend on it.

Publishing is currently manual; a CI publish workflow is planned but not
yet built.

## Spec compatibility

`@openbindings/sdk` declares which spec versions it supports via
`MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION` (and `supportedRange()` /
`isSupportedVersion(v)`), exported from `packages/sdk/src/version.ts`.
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
