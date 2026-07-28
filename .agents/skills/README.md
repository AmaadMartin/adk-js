# Agent skills for working on adk-js

This directory holds reusable skills for AI coding agents working **on this
repository**. Each skill is a directory containing a `SKILL.md` in the portable
Agent Skills format, so any coding agent that reads a skills directory can pick
one up. An agent selects a skill by matching the task at hand against the
`description` in the skill's frontmatter, then follows the instructions in the
body.

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
   `metadata`, `compatibility`. Do not use `allowed-tools` — the loader
   currently derives an extra `allowedTools` key from it, which
   `validateSkillDir` then reports as an unknown field, failing validation.
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

## Not to be confused with the runtime Skills feature

ADK also ships a runtime Skills feature in `core/src/skills/` that lets an ADK
**agent** load skills while it runs. This directory is **developer tooling** for
contributors working on the repo — it ships no runtime behaviour. The two share
a file format, and the test above deliberately reuses the runtime loader as its
validator, but they are different things.
