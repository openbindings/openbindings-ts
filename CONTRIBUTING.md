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
pnpm -r build   # builds every package (the SDK first; formats depend on it)
pnpm test       # runs the whole workspace's vitest suites, all packages at once
pnpm lint       # per-package tsc --noEmit across the workspace
```

`pnpm test` (root `vitest run`) discovers every `*.test.ts` across all packages,
so it is the full suite, not just the SDK's. To exercise one package, use
`pnpm --filter @openbindings/<pkg> test`.

## Format parity is a non-goal

The Go and TS **core** SDKs are behaviorally identical (same types, error
codes, invocation semantics). **Format coverage is not paritized.** The TS
workspace ships no gRPC, Connect, or CLI/usage invoker by design: a browser or
Worker consumer delegates protocol work to a running `ob start` rather than
reimplementing every wire protocol in the page. Do not port those formats to
TS; the real gap worth closing is a single frame-protocol client that delegates
to `ob`. See `ob-pj/.claude/release-readiness.md` for the named, deliberate
non-mirrors.

## Releasing

This is a pnpm workspace monorepo. All packages currently version in lockstep
(a single `vX.Y.Z` tag covers every package under `packages/`).

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
