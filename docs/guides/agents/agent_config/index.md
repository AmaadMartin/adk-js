# Agent configs

An agent config is a YAML file that describes an agent tree. `loadAgentFromConfigFile()`
reads that file and builds the agents, so you can change an agent's model,
instruction or sub-agents without changing TypeScript. The wire format is the
one adk-python reads, so the same file works in both SDKs.

## Introduction

Writing an agent tree in code couples the shape of the tree to a build step.
A config file separates them: an operator edits the YAML, and the process loads
it at startup. This is the same trade-off a routing table or a dependency
injection file makes.

The file names things it does not contain. A `config_path` names another config
file, and the loader reads it. A `code` reference names a value in your program
— a callback, a schema, a model, a custom agent class — and the loader asks
_you_ to resolve it. Resolution is yours because a config file that could reach
any name in the process would be a way to run arbitrary code. Built-in ADK tools
are the exception: `google_search` and its nine siblings resolve on their own,
because the set is fixed and known.

The published JSON Schema, `core/src/agents/configs/AgentConfig.json`, describes
this format. Point an editor at it and you get completion and validation while
you type. A unit test regenerates the schema from the Zod types and fails if the
checked-in file has drifted, so what an editor validates against is always what
the loader accepts.

## Get started

Write a root config and one child:

```yaml
# root_agent.yaml
name: code_pipeline_agent
description: Writes, reviews and refactors code.
agent_class: SequentialAgent
sub_agents:
  - config_path: sub_agents/code_writer_agent.yaml
```

```yaml
# sub_agents/code_writer_agent.yaml
name: code_writer_agent
model: gemini-2.5-flash
description: Writes initial code based on a specification.
instruction: |
  You are a Code Writer AI.
output_key: generated_code
tools:
  - name: google_search
```

Load it:

```ts
import {loadAgentFromConfigFile} from '@google/adk';

const rootAgent = await loadAgentFromConfigFile('./root_agent.yaml');
```

A relative path resolves against the working directory. A `config_path` inside a
file resolves against the directory of the file that names it.

## Run a config with the CLI

You do not need the TypeScript above. Name the root config `root_agent.yaml`
and the ADK CLI loads it for you:

```
my_agents/
  greeter/
    root_agent.yaml
    sub_agents/
      code_writer_agent.yaml
```

```sh
adk web my_agents          # "greeter" appears in the agent list
adk api_server my_agents   # GET /list-apps returns ["greeter"]
adk run my_agents/greeter/root_agent.yaml
```

`adk web` and `adk api_server` read one agent per directory. A directory becomes
an agent when it holds `root_agent.yaml` or `root_agent.yml`. An `app` or
`agent` file still wins over a config, so adding a config to a directory that
already has TypeScript changes nothing.

`adk run` takes the config file itself. Nothing is compiled on this path, so a
config agent needs no build step.

A config that fails validation stops the load and names the file:

```
AgentConfigError: Invalid agent config in /tmp/yaml_agents/greeter/root_agent.yaml: ✖ Unrecognized key: "instuction"
✖ Invalid input: expected string, received undefined
  → at instruction
```

## Agent classes

`agent_class` selects the shape the document is validated against. Omit it and
you get an `LlmAgent`.

| `agent_class`            | Extra fields                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `LlmAgent` (the default) | `model`, `instruction`, `tools`, `output_key`, `include_contents`, the model and tool callbacks, `generate_content_config` |
| `LoopAgent`              | `max_iterations`                                                                                                           |
| `ParallelAgent`          | none                                                                                                                       |
| `SequentialAgent`        | none                                                                                                                       |
| anything else            | anything; the extra keys reach your constructor                                                                            |

The four built-in classes also accept the qualified spellings adk-python's
`importlib` makes interchangeable, so `google.adk.agents.LlmAgent` and
`google.adk.agents.llm_agent.LlmAgent` both work.

## Resolving code references

Pass a `resolveReference` function to name the values a config may reach:

```ts
import {loadAgentFromConfigFile} from '@google/adk';
import {logBeforeModel} from './callbacks.js';

const agent = await loadAgentFromConfigFile('./root_agent.yaml', {
  resolveReference: (name) =>
    ({'callbacks.logBeforeModel': logBeforeModel})[name],
});
```

```yaml
name: writer
instruction: Write code.
before_model_callbacks:
  - name: callbacks.logBeforeModel
```

Your resolver is the trust boundary. A resolver that looks a name up in a fixed
table, as above, can only ever return what you put in the table. A resolver that
imports whatever name it is given runs whatever the config file asks for.

Callbacks keep the order they have in the document, because that is the order
they run in.

## Tools

A tool entry names a tool. Ten built-in tools resolve with no resolver:
`enterprise_web_search`, `exit_loop`, `get_user_choice`, `google_maps_grounding`,
`google_search`, `load_artifacts`, `load_memory`, `preload_memory`,
`request_input` and `url_context`. Any other name goes to your resolver, which
must return a `BaseTool` or a `BaseToolset`.

An entry can also carry `args`. Two shapes are supported:

```yaml
tools:
  # Wrap another agent as a tool.
  - name: AgentTool
    args:
      agent:
        config_path: sub_agents/helper.yaml
      skip_summarization: true
  # Call a function that builds a tool.
  - name: mytools.makeSearchTool
    args:
      threshold: 4
```

`args` on anything else raises `UNSUPPORTED_TOOL_ARGS` rather than dropping the
configuration silently. adk-js has no general `BaseTool.fromConfig` protocol
yet, so these two are what the loader knows how to build.

## Failures

Every failure is an `AgentConfigError` carrying an `AgentConfigErrorCode`:

| Code                           | Cause                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `CONFIG_FILE_NOT_FOUND`        | The file does not exist.                                                            |
| `INVALID_CONFIG`               | The YAML does not parse, the root is not a mapping, or a field fails validation.    |
| `UNSUPPORTED_AGENT_CLASS`      | An `agent_class` that is not built in and does not resolve to an agent constructor. |
| `UNRESOLVED_REFERENCE`         | A name the resolver did not return, or returned the wrong kind of value for.        |
| `INVALID_AGENT_REFERENCE`      | A `sub_agents` entry that sets both `config_path` and `code`, or neither.           |
| `ABSOLUTE_SUB_AGENT_PATH`      | A `config_path` that is an absolute path.                                           |
| `PATH_TRAVERSAL`               | A `config_path` that resolves outside the referencing directory.                    |
| `CIRCULAR_SUB_AGENT_REFERENCE` | A config that is already being loaded further up the tree.                          |
| `UNSUPPORTED_TOOL_ARGS`        | `args` on a tool the loader cannot build from them.                                 |

The path checks compare resolved path strings after `fs.realpath`. They stop a
config file from reaching a sibling directory by accident. They are not a
sandbox: they say nothing about a path swapped between the check and the read,
or about hard links.

## Regenerating the schema

Change a Zod schema in `core/src/agents/configs/agent_config.ts` and the drift
test fails until you run:

```sh
npm run generate:agent-config-schema
```

## Fields adk-python has that adk-js does not

`static_instruction` is absent. Python types it `types.ContentUnion`, which
admits a `PIL.Image.Image`, and adk-js has no equivalent.
