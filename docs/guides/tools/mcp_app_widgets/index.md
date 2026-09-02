# MCP App UI widgets

An MCP server can back a tool with an MCP App: a UI resource that a host
renders next to the tool response. `MCPTool` reads that declaration and pushes a
widget onto the event actions after a successful call. Reach for this when your
UI must show a chart, a form or a map that the tool produced, rather than text.

## Introduction

The [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps)
lets a server declare a `ui://` resource on a tool, in the tool's `_meta` field.
The resource is the UI; the tool call supplies the data. Neither the model nor
the agent renders anything. The host does, and it needs three facts: which
resource to load, which tool produced the data, and what arguments the tool ran
with.

`MCPTool` carries those three facts as a `UiWidget` on `Context.actions`. A
widget is inert data. ADK never fetches the resource and never runs the app, so
a host that ignores `renderUiWidgets` behaves exactly as it does today. Widgets
from parallel tool calls concatenate rather than overwrite each other, so a turn
with three MCP App calls yields three widgets.

Two related additions ride the same call path. `MCPTool` sends the active
OpenTelemetry trace context in the request's `_meta`, so a server can join the
caller's trace. With debug logging on, it records the HTTP exchanges of the call
onto the invocation, for a bug report.

## Get started

An MCP server declares the resource in the tool's `_meta`:

```js
server.registerTool(
  'render_chart',
  {
    description: 'Renders a chart in an MCP App.',
    inputSchema: {series: z.array(z.number())},
    _meta: {ui: {resourceUri: 'ui://charts/bar'}},
  },
  async ({series}) => ({
    content: [{type: 'text', text: `charted ${series.length} points`}],
  }),
);
```

Read the declaration from the tool, then call it:

```ts
import {BaseTool, MCPTool, MCPToolset} from '@google/adk';

function isMcpTool(tool: BaseTool): tool is MCPTool {
  return 'rawMcpTool' in tool;
}

const toolset = new MCPToolset({
  type: 'StdioConnectionParams',
  serverParams: {command: 'node', args: ['./chart_server.mjs']},
});

const tools = await toolset.getTools();
const chart = tools.filter(isMcpTool).find((t) => t.name === 'render_chart')!;

chart.mcpAppResourceUri; // 'ui://charts/bar'
chart.rawMcpTool.name; // 'render_chart' — the server's own definition

await chart.runAsync({args: {series: [1, 2, 3]}, toolContext});

toolContext.actions.renderUiWidgets;
// [{
//   id: <the function call id>,
//   provider: 'mcp',
//   payload: {
//     resource_uri: 'ui://charts/bar',
//     tool: <the raw MCP Tool>,
//     tool_args: {series: [1, 2, 3]},
//   },
// }]
```

The payload keys are snake_case. The payload crosses the wire verbatim, so a
host reading an event from any ADK SDK sees one spelling.

## When no widget appears

`mcpAppResourceUri` is `undefined`, and no widget is rendered, in every case
below. A remote server populates `_meta`, so ADK narrows it instead of trusting
it, and a malformed declaration is never an error.

| Case                                                 | Result                                    |
| ---------------------------------------------------- | ----------------------------------------- |
| The tool has no `_meta`, or `_meta` is not an object | No declaration                            |
| `_meta.ui` is missing or is not an object            | No declaration                            |
| The resource URI does not start with `ui://`         | No declaration                            |
| The call failed                                      | No widget; the error propagates unchanged |
| The context has no `functionCallId`                  | No widget; a host cannot address it       |

A server may also use the deprecated flat spelling,
`_meta['ui/resourceUri']`. ADK reads both and prefers the nested one.

`Context.renderUiWidget` throws if a widget with the same id is already on the
actions, because a host cannot tell two same-id widgets apart.

## Trace context

`MCPTool` injects the active trace context into the request's `_meta`, which the
MCP protocol reserves for this kind of extension:

```ts
// The server sees, on tools/call:
//   params._meta == {traceparent: '00-…-01', tracestate: 'foo=bar'}
```

The key is added only when the registered propagator produces something. A run
with no telemetry configured sends the same bytes as before.

## HTTP debug capture

With debug logging on, a streamable-HTTP MCP call records each HTTP exchange and
attaches the recording to the invocation:

```ts
import {LogLevel, setLogLevel} from '@google/adk';

setLogLevel(LogLevel.DEBUG);
await chart.runAsync({args: {series: [1, 2, 3]}, toolContext});

toolContext.customMetadata['http_debug_info'];
// [{url: 'https://server/mcp', method: 'POST', status: 200, durationMs: 42,
//   requestHeaders: {authorization: '<redacted>'},
//   responseHeaders: {'content-type': 'application/json'}}]
```

Three guarantees make the recording safe to attach to a bug report:

- Credential headers are replaced with `<redacted>`.
- Request and response bodies are never captured.
- A recording holds at most 100 exchanges, so a long-running agent cannot grow
  it without limit.

The recording drains on the success path and on the error path. With debug
logging off, no recording is installed and `http_debug_info` is never created.
