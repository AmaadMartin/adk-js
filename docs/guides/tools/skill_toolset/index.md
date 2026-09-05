# SkillToolset

`SkillToolset` gives an agent a set of skills: folders of instructions, reference documents, assets and runnable scripts. Reach for it when a capability is better described as a document the model reads on demand than as a function the model calls.

## Introduction

A skill is a folder with a `SKILL.md` at its root and optional `references/`, `assets/` and `scripts/` subfolders. The toolset exposes five tools over that set: `list_skills`, `search_skills`, `load_skill`, `load_skill_resource` and `run_skill_script`. The model discovers a skill, reads its instructions, then follows them, pulling in a reference file or running a script as the instructions direct.

The alternative is putting every capability in the system instruction. That costs prompt budget on every request and does not scale past a handful of capabilities. A skill's body is only loaded when the model asks for it.

The toolset also writes its own guidance into the system instruction. That text is built from the tools the toolset actually exposes, so a `toolFilter` that removes `load_skill_resource` produces an instruction that forbids it instead of advertising it.

Two backends can run a skill's script, and they are mutually exclusive:

- A `BaseCodeExecutor` runs a generated wrapper around the script. The toolset ships the skill's files to the executor as input files, and the model supplies arguments.
- A `BaseEnvironment` runs a shell command the model writes. The toolset writes the skill's files into the environment's filesystem first.

## Get started

```ts
import {
  LlmAgent,
  SkillToolset,
  UnsafeLocalCodeExecutor,
  loadSkillFromDir,
} from '@google/adk';

const skill = await loadSkillFromDir('./skills/word-count');

export const rootAgent = new LlmAgent({
  name: 'skill_agent',
  model: 'gemini-2.5-flash',
  tools: [
    new SkillToolset([skill], {codeExecutor: new UnsafeLocalCodeExecutor()}),
  ],
});
```

## Running a script in an environment

Pass an `environment` instead of a `codeExecutor`. `run_skill_script` then declares a required `command` parameter and drops `args`, `short_options` and `positional_args`: the model writes the whole command line.

```ts
import {
  LlmAgent,
  LocalEnvironment,
  SkillToolset,
  loadSkillFromDir,
} from '@google/adk';

const skill = await loadSkillFromDir('./skills/word-count');
const environment = new LocalEnvironment({workingDir: './workspace'});

export const rootAgent = new LlmAgent({
  name: 'skill_agent',
  model: 'gemini-2.5-flash',
  tools: [new SkillToolset([skill], {environment, scriptTimeoutSeconds: 60})],
});
```

The first time one of a skill's scripts runs, the toolset writes that skill's references, assets and scripts into `<skillsFolder>/<skillName>/`. `skillsFolder` defaults to `skills` beneath the environment's working directory; set it to an absolute path to place them elsewhere. The system instruction tells the model that folder, so it can write a command that finds the script.

The response is `{stdout, stderr, exit_code, timed_out}`. A non-zero exit code is reported, not thrown.

A resource whose name climbs out of `<skillsFolder>/<skillName>/` is refused before anything is written, and the call returns `EXECUTION_ERROR`. The check is lexical. It stops a traversing name, and it does not survive a symlink the environment already holds.

### Confirming the command

The model writes the command, and `LocalEnvironment` runs it on the host. Every command therefore waits for a client to approve it, the same way `run_skill_inline_script` does. No option turns this off.

The first call returns `{partial: 'This tool call needs external confirmation before completion.'}` and records a request that carries the command. Nothing runs and nothing is written yet. Once the client answers:

- Confirmed: the toolset materializes the skill and runs the command.
- Rejected: the call returns `CONFIRMATION_REJECTED` and the command never runs.

A call that cannot reach the command asks for nothing. A missing `command` argument, an unknown skill and an unknown script each return their own error first.

`LocalEnvironment` runs the command on the host with no sandboxing. Scope it to a workspace directory you are willing to let a model write to.

## Script arguments on the code-executor path

Without an environment, the model supplies arguments rather than a command line:

- `args` as an object becomes long options: `{verbose: true}` -> `--verbose true`.
- `args` as an array is the complete argument vector, and `short_options` and `positional_args` must then be absent.
- `short_options` becomes single-hyphen options: `{n: 5}` -> `-n 5`.
- `positional_args` follows a `--` separator.

A bad type in any of the three returns `INVALID_ARGUMENTS` and the script does not run.

The response carries `status`, derived from what the run reported. A non-zero exit code is an `error`. With no exit code reported, output on stderr alone is an `error`, and stderr alongside stdout is a `warning`.

## Guarding against a retry loop

A model that gets `RESOURCE_NOT_FOUND` sometimes guesses a different wrong path and tries again. The toolset counts every lookup failure within one invocation, whatever the path, and the second failure returns `RESOURCE_NOT_FOUND_FATAL` with an instruction to stop. `run_skill_script` does the same with `SCRIPT_NOT_FOUND_FATAL`. The count lives under a `temp:` state key, so it never reaches durable session storage and never leaks into the next invocation.

## Injecting session state into a skill's instructions

Set `metadata.adk_inject_state: true` in a skill's frontmatter and `load_skill` interpolates session state into its instructions:

```yaml
---
name: greeting
description: Greets the user by name.
metadata:
  adk_inject_state: true
---
Greet {user_name} warmly.
```

Templating is opt-in so that a skill whose instructions legitimately contain braces is not rewritten behind its author's back.

## Selecting and renaming the tools

`toolFilter` takes a list of tool names or a predicate. `toolNamePrefix` renames every tool, so two skill toolsets can live on one agent:

```ts
new SkillToolset([skill], {
  toolNamePrefix: 'docs',
  toolFilter: ['docs_list_skills', 'docs_load_skill'],
});
```

The filter operates on the final, prefixed names. `run_skill_script` is hidden entirely when nothing can run a script: no `environment`, no toolset `codeExecutor`, and an agent that has none either.
