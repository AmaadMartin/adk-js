# Declarative LlmAgent configuration

Describe an agent in a YAML or JSON document instead of in code, and get the
same agent you would have written by hand. Reach for it when the agent is
configuration rather than logic: an operator edits the instruction, a
deployment picks a different model, or a test fixture declares an agent without
compiling anything.

## Introduction

`LlmAgentConfig` is the option object the `LlmAgent` constructor takes. It
holds live values — a `BaseLlm` instance, tool instances, functions — so a
configuration file cannot express it.

`LlmAgentYamlConfig` is the declarative counterpart. It holds only data:
strings, booleans, and references that name an exported value. Two functions
bridge the two:

- `parseLlmAgentConfig(raw)` validates a parsed document and fills in the
  defaults. It rejects an unknown key rather than ignoring it, so a misspelled
  key is reported instead of doing nothing.
- `llmAgentFromConfig(config, baseFilePath)` resolves every reference in the
  document and constructs the `LlmAgent`.

The split is deliberate. Validation is pure and runs anywhere, including in a
browser. Resolution imports the modules the document names, so it runs on Node
only and is exported from `@google/adk` alone.

The document is the same shape adk-python accepts, so a config written for one
SDK validates in the other. Both the `snake_case` spelling adk-python writes
and the `camelCase` spelling TypeScript writes are accepted.

## Get started

Three files. First the agent document:

```yaml
# root_agent.yaml
agent_class: LlmAgent
name: docs_agent
description: answers questions about the docs
instruction: Answer the user's question, citing your sources.
model: gemini-2.5-flash
output_key: answer
tools:
  - name: ./my_tools.js#createRetriever
    args:
      corpus_id: docs-prod
```

Then the module it names:

```ts
// my_tools.ts
import {FunctionTool} from '@google/adk';

export function createRetriever(args: {corpus_id: string}): FunctionTool {
  return new FunctionTool({
    name: `retrieve_${args.corpus_id}`,
    description: 'Retrieves documents from a corpus.',
    execute: () => ({corpusId: args.corpus_id}),
  });
}
```

Then the loader:

```ts
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import yaml from 'js-yaml';
import {llmAgentFromConfig, parseLlmAgentConfig} from '@google/adk';

const configPath = resolve('root_agent.yaml');
const config = parseLlmAgentConfig(
  yaml.load(await readFile(configPath, 'utf8')),
);
const agent = await llmAgentFromConfig(config, configPath);
```

`baseFilePath` is the absolute path of the document. A `./`-relative reference
resolves against its directory, and fails without it rather than guessing.

## Naming a value in code

A reference is `<module specifier>#<export>`. With no `#` the whole string is
the specifier and the `default` export is read. The specifier is a relative
path, an absolute path, or a package name:

```yaml
tools:
  - name: ./my_tools.js#searchTool # relative to this document
  - name: '@google/adk#GOOGLE_SEARCH' # a package export
```

References appear wherever the document needs a value it cannot spell:

| Key                             | What the reference must name                              |
| ------------------------------- | --------------------------------------------------------- |
| `model_code`                    | a `BaseLlm`, for a model that needs constructor arguments |
| `tools[].name`                  | a tool, a toolset, or a factory that builds one           |
| `input_schema`, `output_schema` | a Zod object, or a schema object                          |
| `sub_agents[].code`             | an agent instance                                         |
| `*_callbacks[].name`            | a function                                                |

A tool entry may carry `args`. Its keys reach the factory exactly as the
document writes them — `corpus_id` stays `corpus_id` — because they belong to
the tool, not to ADK. Naming a tool that already exists and passing `args` is
an error, because nothing would read them.

Callbacks run in the order the document lists them.

## A model built in code

Use `model` for a model name, and `model_code` for a model that needs
arguments. Setting both is an error:

```yaml
model_code:
  name: ./clients.js#myLiteLlm
```

The resolved object reaches the agent by identity, so a pre-configured client
keeps its configuration.

## Failure modes

Every failure throws `InputValidationError`. The message states the rule the
document broke; the underlying failure — the `ZodError` naming the offending
key, or the module-loading error — rides on `cause`.

Resolving a reference **imports the named module, which runs its top-level
code**. Trust a configuration document exactly as far as you trust the code it
can name. Two specifiers are refused for that reason: a Node built-in, so a
document cannot reach `node:child_process`, and anything carrying a URL scheme,
because `import()` runs a `data:` URL that carries its own source.

A `sub_agents` entry must use `code`. Loading a sub-agent from its own config
file is not supported yet, and the resolver says so rather than dropping the
sub-agent silently.
