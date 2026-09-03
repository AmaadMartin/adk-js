# CodeConfig and AgentRefConfig

`CodeConfig` and `AgentRefConfig` are the two reference types a configuration
document is built out of. `CodeConfig` names a value defined in code.
`AgentRefConfig` names another agent. Reach for them when you read agent
configuration from a file and have to turn a name in that file into a real
object.

## Introduction

A configuration document holds data, not objects. A tool, a callback, or a
sub-agent is code, so the document can only name it. These two types are that
name, plus the rules the name obeys.

`CodeConfig` carries one required `name`, in the form
`<module specifier>#<export>`. `resolveCodeReference` imports the module and
reads the export. `AgentRefConfig` carries either `code`, a name of the same
form, or `configPath`, a sibling config file. Exactly one of the two is set;
the parser and `resolveAgentReference` both enforce that, so a hand-built
object is held to the same rule as a parsed document.

adk-js has no agent config loader yet, so `resolveAgentReference` rejects a
`configPath` reference. Name the agent with `code` instead.

Both parsers reject an unknown key. This matches adk-python's `extra="forbid"`
and turns a misspelled key into an error instead of a silently ignored setting.
`parseAgentRefConfig` also accepts `config_path`, the key adk-python writes, and
normalizes it to `configPath`.

## Get started

Name an exported value from a configuration document, and resolve it:

```ts
import {parseCodeConfig, resolveCodeReference} from '@google/adk';

const config = parseCodeConfig({name: './my_tools.js#searchTool'});
const tool = await resolveCodeReference(config, '/workspace/root_agent.yaml');
```

The second argument is the absolute path of the file the name came from. A
`./`-relative specifier resolves against its directory. A bare specifier such as
`my-package#thing` resolves the way Node resolves any package, and an absolute
path resolves directly, so neither needs a base path.

Name a sub-agent that lives in code:

```ts
import {parseAgentRefConfig, resolveAgentReference} from '@google/adk';

const ref = parseAgentRefConfig({code: './custom_agents.js#myCustomAgent'});
const agent = await resolveAgentReference(ref, '/workspace/root_agent.yaml');
```

`resolveAgentReference` returns a `BaseAgent`. It throws when the name resolves
to something that is not an agent.

## What a reference cannot do

A reference only names an object. A configuration document cannot pass
constructor arguments. To use a configured object, build it in code and name its
export.

A name cannot reach a Node built-in. `node:child_process#exec` and the bare
`child_process#exec` are both refused, so a configuration file cannot run a
shell command through this path.

Resolution imports the named module, which runs that module's top-level code.
Trust a name exactly as far as you trust the configuration file it came from.

## Failures

Every failure is an `InputValidationError`, so one `catch` covers the parser and
the resolver. The underlying failure, such as the import error behind an
unknown module, is attached as the error's `cause`.

| Condition                                   | Message                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Unknown key, or a bad field type            | `Invalid CodeConfig: <issues>` / `Invalid AgentRefConfig: <issues>` |
| Both `code` and `configPath`                | ``Only one of `code` or `configPath` should be provided``           |
| Neither `code` nor `configPath`             | ``Exactly one of `code` or `configPath` must be provided``          |
| Empty `name` at resolution                  | `Invalid CodeConfig.`                                               |
| Built-in, unknown module, or missing export | `Invalid fully qualified name: <name>`                              |
| `configPath` reference                      | adk-js has no agent config loader; use `code`                       |
| `code` resolves to a non-agent              | ``Agent reference `<code>` does not resolve to an agent.``          |

An empty `name` is a valid document. `parseCodeConfig({name: ''})` succeeds and
`resolveCodeReference` is what rejects it, matching adk-python.
