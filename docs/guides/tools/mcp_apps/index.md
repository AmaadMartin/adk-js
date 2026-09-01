# MCP Apps, trace context and HTTP debug capture

`MCPTool` wraps a tool an MCP server declares. Beyond calling the tool, it
carries three things across the boundary: the MCP App widget a UI host renders,
the trace context the server joins, and the HTTP exchanges an operator needs
when a call fails.

## Introduction

An MCP server can ship an [MCP App](https://modelcontextprotocol.io/): a `ui://`
resource holding an interactive view for one of its tools. The tool response
alone does not tell a UI host to draw it. `MCPTool` reads the resource URI off
the tool declaration and, after a successful call, pushes a `UiWidget` onto the
event actions. The host reads `event.actions.renderUiWidgets` and renders the
App next to the function response.

Two smaller pieces travel the same path. `MCPTool` injects the active
OpenTelemetry context into the `tools/call` request `_meta`, so the server's
spans join the trace the agent started instead of beginning a new one. And with
debug logging on, it records each HTTP exchange of the call onto the
invocation's custom metadata, so a 403 from a policy gateway can be read off
the invocation instead of reproduced behind a proxy.

Session setup is retried once, because a failure while opening a session
provably ran nothing on the server. The tool call itself is never retried:
replaying it after an ambiguous transport failure could duplicate a remote side
effect.

## Get started

Connect a toolset to an MCP server and run the agent as usual. The widget
reaches the event with no extra configuration.

```ts
import {InMemoryRunner, LlmAgent, MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8788/mcp',
});

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer weather questions with the forecast tool.',
  tools: [toolset],
});

const runner = new InMemoryRunner({agent, appName: 'weather'});
const session = await runner.sessionService.createSession({
  appName: 'weather',
  userId: 'u1',
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {parts: [{text: 'Forecast for Paris?'}]},
})) {
  for (const widget of event.actions.renderUiWidgets ?? []) {
    // widget.provider === 'mcp'
    render(widget.payload['resource_uri']);
  }
}
```

## The widget payload

A widget the `mcp` provider pushes has the function call id as its `id`, `'mcp'`
as its `provider`, and three payload fields:

| Key            | Value                                                |
| -------------- | ---------------------------------------------------- |
| `resource_uri` | The `ui://` URI the tool declared.                   |
| `tool`         | The raw MCP tool declaration, as the server sent it. |
| `tool_args`    | The arguments the model called the tool with.        |

The payload keys are snake_case, and the event serializer leaves them alone in
both directions, so a host reads one spelling from the TypeScript and the
Python SDK.

A server declares the resource URI in the tool's `_meta`, in either form:

```json
{"_meta": {"ui": {"resourceUri": "ui://weather/card"}}}
{"_meta": {"ui/resourceUri": "ui://weather/card"}}
```

`_meta` comes from a remote server, so anything that is not a string beginning
with `ui://` reads as "no MCP App declared". Read the URI yourself with
`tool.mcpAppResourceUri`, and read a server field ADK does not model with
`tool.rawMcpTool`.

Two widgets cannot share an id. `Context.renderUiWidget` throws on a duplicate,
because a widget id names one function call.

## HTTP debug capture

Turn debug logging on and the streamable-HTTP transport records what it sent
and received. Each exchange lands on `customMetadata.http_debug_info` on the
invocation, on the successful and the failing path alike:

```ts
import {LlmAgent, LogLevel, setLogLevel} from '@google/adk';

setLogLevel(LogLevel.DEBUG);

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.5-flash',
  tools: [toolset],
  afterToolCallback: ({context}) => {
    report(context.customMetadata['http_debug_info']);
    return undefined;
  },
});
```

An entry holds the URL, the status code, the method, and the headers and bodies
of both sides. Three limits apply:

- Credential-bearing headers — `authorization`, `cookie`, `set-cookie`,
  `api-key`, `x-api-key`, `x-goog-api-key` and `proxy-authorization` — are
  replaced with `<redacted>`, and a credential in the URL is masked.
- A body longer than 1000 characters is cut, with a `... [truncated]` suffix.
- One call records at most 50 exchanges and drops the rest, because a streaming
  session makes an unbounded number of round trips and the record travels on
  the invocation.

An event-stream response is recorded as `<SSE stream>` rather than read:
draining it would starve the transport of its events.

With debug logging off no wrapper is installed, and the transport sends exactly
the bytes it sends without this feature.
