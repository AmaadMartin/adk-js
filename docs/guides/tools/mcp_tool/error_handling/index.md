# MCP tool error handling

An MCP tool call can fail for reasons the model never sees: the server dies
mid-call, a gateway answers 403, or the transport drops. Turn on
`MCP_GRACEFUL_ERROR_HANDLING` and `MCPTool` hands the model an `{error}` result
instead of throwing, so the agent turn continues.

## Introduction

`MCPTool.runAsync` opens a session, calls the remote tool, and closes the
session. When any step throws, the error travels up through the tool call to
the runner and ends the invocation. The model never learns that the tool
failed, so it cannot apologise, retry another tool, or answer from what it
already knows.

There are two kinds of failure here, and only one of them reaches the model
today. A tool that runs and reports a problem returns a normal result with
`isError: true`; the model sees it. A tool that never runs at all raises an
error; the model sees nothing. This feature closes that second gap by catching
the error and describing it as a result.

The feature is off by default, because turning a throw into a value is a
visible behaviour change for any caller that catches MCP failures today. It is
registered as experimental, and matches adk-python's
`MCP_GRACEFUL_ERROR_HANDLING` feature so the two SDKs behave the same way.

## Get started

Enable the feature, then use the toolset as usual:

```ts
import {
  FeatureName,
  LlmAgent,
  MCPToolset,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING, true);

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
});

const agent = new LlmAgent({
  name: 'mcp_agent',
  model: 'gemini-2.0-flash',
  tools: [toolset],
});
```

Setting `ADK_ENABLE_MCP_GRACEFUL_ERROR_HANDLING=1` in the environment does the
same thing, and `ADK_DISABLE_MCP_GRACEFUL_ERROR_HANDLING=1` turns it back off.
A programmatic override wins over both.

## What the model receives

| Failure                                                  | Result                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| An MCP protocol error, such as the server dying mid-call | `{error: 'MCP tool execution failed: MCP error -32000: Connection closed'}` |
| Any other error, such as a transport failure             | `{error: 'Unexpected error during MCP tool execution: <root cause>'}`       |

The second message reports the root cause, so a wrapped error reads as
`Failed to create MCP session: ECONNREFUSED 127.0.0.1:8788` rather than as the
outer message alone. ADK logs the same text at warning level.

A successful call is untouched. That includes a result the server marked
`isError: true`: the tool ran and answered, so the answer goes to the model as
it arrived, with every field the server sent.

The session still closes on the failing path, exactly as it does when the error
throws.

## Reading MCP-App metadata

An MCP-App server describes its user interface in the tool's `_meta` block.
`MCPTool` exposes three accessors over it:

```ts
tool.rawMcpTool; // the declaration exactly as the server advertised it
tool.visibility; // ['app', 'debug'] from _meta.ui.visibility, or []
tool.mcpAppResourceUri; // 'ui://widget/echo' from _meta.ui.resourceUri
```

`mcpAppResourceUri` reads the nested `_meta.ui.resourceUri` form first, then
the deprecated flat `_meta['ui/resourceUri']` form, and returns `undefined`
when neither holds a `ui://` URI. See the
[MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

ADK reads this metadata but does not render it. Nothing in adk-js draws an
MCP-App widget yet, so the accessors are for your own code.
