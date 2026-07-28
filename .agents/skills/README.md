# Agent skills for working on adk-js

This directory holds reusable skills for AI coding agents working **on this
repository**. Each skill is a directory containing a `SKILL.md` in the portable
Agent Skills format, so any coding agent that reads a skills directory can pick
one up. An agent selects a skill by matching the task at hand against the
`description` in the skill's frontmatter, then follows the instructions in the
body. This is developer tooling and ships no runtime behaviour — it is
unrelated to the runtime Skills feature in `core/src/skills/`, from which it
borrows the file format and the validator.

## Index

- [`adk-cross-language-port`](adk-cross-language-port/SKILL.md) — port a
  feature from `adk-python` into `adk-js`, or verify that an existing module is
  still at parity.

## Adding a skill

1. Create `.agents/skills/<skill-name>/SKILL.md`. The directory name must equal
   the frontmatter `name`.
2. `name` is lowercase kebab-case, at most 64 characters. `description` is a
   trigger sentence saying what the skill does **and when to use it**, under
   1024 characters.
3. Only these frontmatter keys are accepted: `name`, `description`, `license`,
   `metadata`, `compatibility`. Avoid `allowed-tools`: the loader derives an
   `allowedTools` key from it that then fails the unknown-field check, so the
   error names a key you never wrote.
4. Keep `SKILL.md` short (roughly under 200 lines). Move long material into
   `references/*.md` and link it from `SKILL.md`.
5. Helper programs go in `scripts/`, static files in `assets/`.
6. Add an entry to the index above linking to `<skill-name>/SKILL.md`.
7. Validate locally:

   ```bash
   npx vitest run --project integration \
     tests/integration/agent_skills/agent_skills_library_test.ts
   ```

   The test loads every directory here with ADK's own skill loader and fails if
   a skill is malformed or missing from the index.
