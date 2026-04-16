# Contributing to openbindings-ts

## Workflow

1. Branch from `main`: `git checkout -b <type>/<short-description>`.
   Types: `fix`, `feat`, `docs`, `chore`, `refactor`.
2. Commit and push.
3. `gh pr create --fill --base main`.
4. Squash-merge when CI is green (`gh pr merge --squash --auto --delete-branch`).

All changes land on `main` via squash-merged PRs. No direct commits to `main`.

## Testing

```bash
pnpm install
pnpm -r build
pnpm test
pnpm lint   # per-package tsc --noEmit across the workspace
```

## Releasing

This is a pnpm workspace monorepo. All packages currently version in lockstep
(single `vX.Y.Z` tag covers all six packages).

```bash
# From the workspace root, bump each package.json to the new version, then:
git tag vX.Y.Z
git push origin vX.Y.Z
pnpm -r build
pnpm -r publish --access public
```

npm publish is currently manual; a release GitHub Action is planned. Pre-1.0,
minor versions may include breaking changes; document under **Changed** or
**Removed** in `CHANGELOG.md`.

## Spec compatibility

`@openbindings/sdk` declares which spec versions it supports via:

- `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION` (exported constants)
- `supportedRange()` / `isSupportedVersion(v)`

Located in `packages/sdk/src/version.ts`. When the spec bumps, update these
constants in the same PR that adds support for the new version.

## Broader context

This repo is part of the openbindings-project. See the monorepo-wide
orientation doc at `ob-pj/CLAUDE.md` (local to contributor machines) for
cross-repo conventions, release flow, and the "spec doesn't privilege any
implementation" principle.
