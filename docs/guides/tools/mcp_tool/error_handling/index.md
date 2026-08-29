# MCP tool error handling

`MCPTool` reports a failed call to the model as an `{error}` result instead of
throwing. Reach for this page when an MCP server rejects a call, drops the
connection, or answers with a protocol error, and you need to know what the
agent sees.

## Introduction

An MCP server is a separate process, often behind a gateway. It fails in ways
the agent cannot prevent: a 403 from a policy engine, a dropped stream, a tool
that raises. Before this behaviour, such a failure threw out of `runAsync` and
ended the agent turn, so one bad tool call lost the whole conversation.

`MCPTool` now catches the failure and returns `{error: '<summary>: <message>'}`.
The model reads that result like any other tool output, so it can apologise,
try another tool, or ask the user for help. This matches `McpTool` in
adk-python, which converts the same failures behind the same feature name.

Two things are deliberately outside the boundary. A cancelled call still
throws, because the caller has already stopped waiting and the model must not
be told about a failure the caller caused. The MCP session is still closed on
every path, so a converted error never leaks a session.

## Get started

Nothing to configure — the behaviour is on by default:

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8788/mcp',
});

const [tool] = await toolset.getTools();
const result = await tool.runAsync({args: {}, toolContext});
// A server that rejects the call gives:
// {error: 'MCP tool execution failed: MCP error -32603: boom'}
```

## The two messages

The summary tells you which layer failed.

| Failure                                              | Result                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| The server answered with an MCP protocol error       | `{error: 'MCP tool execution failed: <message>'}`                  |
| Anything else, including a session that never opened | `{error: 'Unexpected error during MCP tool execution: <message>'}` |

`<message>` comes from `formatError`, which unwraps a `cause` chain and appends
the HTTP status and response body when the error carries them. It truncates a
body at 1000 characters, so a large error page cannot flood the result.

The same message is logged at `warn` level.

## Turning it off

Disable the feature to get the old throwing behaviour back. Use the environment
variable for a deployment:

```
ADK_DISABLE_MCP_GRACEFUL_ERROR_HANDLING=1
```

Or override it in process:

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING, false);
```

The feature is `EXPERIMENTAL`, so the first call logs one warning naming it.

## Cancellation

A cancelled call always throws, whether the feature is on or off. `MCPTool`
treats a call as cancelled when `toolContext.abortSignal` is aborted, or when
the thrown error is named `AbortError`. Catch it where you cancel, not in the
model's result.
