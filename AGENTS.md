# AGENTS.md

Agent Development Kit (ADK) for TypeScript is an open-source, code-first
toolkit for building, evaluating, and deploying AI agents. It is the TypeScript
sibling of `adk-python` and tracks it closely, so a large share of the work in
this repo is keeping the two implementations at parity.

## Repository layout

- `core/` — the `@google/adk` package: agents, tools, models, sessions,
  memory, artifacts, and the rest of the SDK surface.
- `dev/` — the `@google/adk-devtools` package: the CLI and the dev server.
- `integrations/` — the `@google/adk-integrations` package.
- `tests/` — repo-level `integration`, `e2e` and `cross_language` suites;
  per-package unit tests live in `core/test`, `dev/test` and
  `integrations/test`.
- `docs/` — design documents.

## Skills

Skills for working on this repo live in `.agents/skills/`. Start at
[`.agents/skills/README.md`](.agents/skills/README.md) for the index and for
the rules on adding one.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup and code quality
requirements. The entry points are `npm run build`, `npm test` and
`npm run lint`.
