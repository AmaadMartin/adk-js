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
form, or `configPath`, a sibling config file. Exactly one of the two is set,
and `parseAgentRefConfig` enforces that.

Both parsers reject an unknown key. This matches adk-python's `extra="forbid"`
and turns a misspelled key into an error instead of a silently ignored setting.
`parseAgentRefConfig` also accepts `config_path`, the key adk-python writes, and
normalizes it to `configPath`.

adk-js has no agent config loader yet, so nothing follows a `configPath` for
you. The type is validated here so that a loader, and the code that reads these
shapes today, agree on one definition.

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

Validate a reference to a sub-agent, then resolve the code it names:

```ts
import {
  isBaseAgent,
  parseAgentRefConfig,
  resolveCodeReference,
} from '@google/adk';

const ref = parseAgentRefConfig({code: './custom_agents.js#myCustomAgent'});
const value = ref.code
  ? await resolveCodeReference({name: ref.code}, '/workspace/root_agent.yaml')
  : undefined;
const agent = isBaseAgent(value) ? value : undefined;
```

`resolveCodeReference` returns `unknown`, so narrow it with the target type's
own guard. Use `isBaseAgent` for an agent, never `instanceof`.

## What a reference cannot do

A reference only names an object. A configuration document cannot pass
constructor arguments. To use a configured object, build it in code and name its
export.

A name cannot reach a Node built-in: `node:child_process#exec` and the bare
`child_process#exec` are both refused. A name also cannot carry a URL scheme,
which stops a `data:` URL from supplying the module body itself.

Neither refusal makes a name safe. Resolution imports the named module, which
runs that module's top-level code, so a name pointing at a file on disk runs
whatever that file does. Trust a name exactly as far as you trust the
configuration file it came from.

## Failures

Every failure is an `InputValidationError`, so one `catch` covers the parser and
the resolver. The underlying failure, such as the import error behind an
unknown module, is attached as the error's `cause`.

| Condition                                            | Message                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Bad `CodeConfig` shape, unknown key, or empty `name` | ``A code reference must be an object with a `name` and no other key.``                                           |
| Bad `AgentRefConfig` shape, unknown key, empty field | ``An agent reference must be an object with `code` or `configPath` and no other key.``                           |
| Both `code` and `configPath`                         | ``An agent reference sets both `code` and `configPath`; exactly one of `code` and `configPath` must be set.``    |
| Neither `code` nor `configPath`                      | ``An agent reference sets neither `code` nor `configPath`; exactly one of `code` and `configPath` must be set.`` |
| Built-in, unknown module, or missing export          | `Invalid fully qualified name: <name>`                                                                           |

The message states the rule the document broke. The `ZodError` on `cause` is
what names the offending key, so read `cause` to report a precise location back
to the author of the config file.
