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

## Cross-SDK correspondence

The Go and TypeScript SDKs target the same observable OpenBindings behavior:
the same published binding families, validation decisions, error codes,
invocation state transitions, synthesis coverage accounting, and portable
conformance scenarios. Their public names should correspond where language
idioms permit so knowledge transfers readily between SDKs.

This does not require identical goroutine and promise structure, cancellation
plumbing, connection management, incidental error prose, or other details that
are not observable at the OpenBindings boundary. Runtime constraints may also
differ: browser and Worker consumers can use the host-neutral packages
directly and delegate Node-only protocol work to `ob start`. Such deployment
differences do not relax the family package's conformance obligations.

## Releasing

See [RELEASING.md](RELEASING.md) for the release flow, spec-compatibility
rule, and pre-1.0 policy.

## Broader context

This repo is part of the openbindings-project. See the monorepo-wide
orientation doc at `ob-pj/CLAUDE.md` (local to contributor machines) for
cross-repo conventions, release flow, and the "spec doesn't privilege any
implementation" principle.
