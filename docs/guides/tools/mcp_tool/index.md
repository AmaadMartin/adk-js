# MCPTool

`MCPTool` wraps one tool advertised by a Model Context Protocol (MCP) server so
an agent can call it. Reach for this page when you need to know what the wrapper
does around the call itself: the MCP App widget it renders, the trace context it
sends, the HTTP exchanges it can capture, and the one retry it performs.

## Introduction

`MCPToolset` discovers the tools on a server and hands you one `MCPTool` per
tool. You rarely construct one yourself. What you do need to know is what
happens between the model's function call and the server's answer, because four
behaviours there are observable outside the tool.

The tool opens a fresh session for every call and closes it afterwards. It does
not pool sessions. That makes each call independent, and it is why a connection
failure is safe to retry.

## Get started

```ts
import {LlmAgent, MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8788/mcp',
});

const agent = new LlmAgent({
  name: 'mcp_agent',
  model: 'gemini-flash-latest',
  tools: [toolset],
});
```

Every tool the server advertises is now callable. The sections below describe
what each call does beyond sending `tools/call`.

## MCP App widgets

An MCP App server declares a UI resource on a tool, in the tool's `_meta`:

```json
{"_meta": {"ui": {"resourceUri": "ui://weather-app"}}}
```

After a successful call, `MCPTool` attaches a widget to the event's actions so
the host UI can render the app next to the agent's answer:

```ts
const widget = toolContext.actions.renderUiWidgets?.[0];
// {
//   id: '<the function call id>',
//   provider: 'mcp',
//   payload: {
//     resource_uri: 'ui://weather-app',
//     tool: <the MCP tool definition>,
//     tool_args: {city: 'Paris'},
//   },
// }
```

The payload keys are snake_case. A host UI reads events written by adk-js and by
adk-python, so both SDKs emit the same payload.

Two cases produce no widget, and neither fails the call: a tool that declares no
`ui://` resource URI, and a tool context with no function call id to key the
widget on. The deprecated flat spelling `{"ui/resourceUri": "ui://…"}` is also
read, and the nested spelling wins when a server sends both.

`MCPTool.mcpAppResourceUri` returns the URI a tool declares, or `undefined`.
`MCPTool.rawMcpTool` returns the tool definition the server advertised.

## Trace context

`MCPTool` injects the active OpenTelemetry context into the `_meta` field of the
`tools/call` request, so the server's span is a child of the ADK tool span
rather than a new root.

The carrier comes from the global propagator, which your OpenTelemetry setup
registers. With no propagator registered, or with no active span, the carrier is
empty and the request carries no `_meta` field at all.

## HTTP debug capture

Set the log level to `DEBUG` and `MCPTool` records the HTTP exchanges of each
call on the invocation's metadata bag:

```ts
import {LogLevel, setLogLevel} from '@google/adk';

setLogLevel(LogLevel.DEBUG);

// after the call
const exchanges = toolContext.customMetadata['http_debug_info'];
```

Each record carries `url`, `status_code`, `method`, `request_headers`,
`response_headers` and, when there is one, `request_body` and `response_body`.
Records are appended, so several calls in one invocation accumulate.

Three properties matter, because these records get persisted with the event:

- Credential-bearing headers are masked with `<redacted>`: `api-key`,
  `authorization`, `cookie`, `proxy-authorization`, `set-cookie`, `x-api-key`
  and `x-goog-api-key`. A password embedded in the URL is masked too.
- Bodies are truncated at 1000 characters, and one buffer keeps at most 100
  records.
- A `text/event-stream` response body is recorded as `<SSE stream>` and is never
  read, because reading it would starve the transport of its events.

Capture is on for the streamable-HTTP transport. Stdio has no HTTP layer and
records nothing. Records are also collected when the call fails, so a failing
call is the one you can actually debug.

A custom transport can contribute records with `recordHttpDebug`, which is a
no-op outside a capture:

```ts
import {recordHttpDebug} from '@google/adk';

recordHttpDebug({
  url: 'https://mcp.example.com/mcp',
  status_code: 200,
  method: 'POST',
  request_headers: {},
  response_headers: {},
});
```

## Retry on a connection failure

A call that fails before the server answered is retried once, against a fresh
session. The first session is closed first. This covers a connection refused by
a restarting server, a reset socket, a DNS failure, and a session that could not
be opened at all.

Nothing else is retried. A protocol error means the server received the call and
answered it, so replaying it could duplicate a remote side effect. A cancelled
call is not retried either.
