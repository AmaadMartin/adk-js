# MCPToolset configuration and call guards

Builds an `MCPToolset` from an agent config, bounds every call the toolset makes
to an MCP server, and keeps the server from claiming a name the ADK framework
owns. Reach for this page when you declare an MCP server in a config, when a
listing hangs, or when you need to see the HTTP traffic a call produced.

## Introduction

`MCPToolset` connects to a Model Context Protocol server and exposes its tools
to an agent. The server is a separate program, so everything it does is outside
your control: it can hang, it can fail once and work on retry, and it can
advertise any tool name it likes. The guards on this page put a boundary around
that.

An agent config adds a second problem. A stdio MCP server is a `command` that
ADK launches as a local process, so a config that declares one can run arbitrary
code on the machine loading it. `MCPToolset.fromConfig` therefore refuses a
config-declared stdio server unless the operator opts in. A remote transport
carries no such risk and is always allowed.

These are the JavaScript counterparts of `McpToolset.from_config`,
`_execute_with_session` and `retry_on_errors` in adk-python.

## Get started

Build a toolset from an agent config. Exactly one transport field must be set.

```ts
import {MCPToolset} from '@google/adk';

const toolset = MCPToolset.fromConfig({
  streamableHttpConnectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://example.com/mcp',
    timeout: 5,
  },
  toolFilter: ['read_file'],
  toolNamePrefix: 'files',
});

const tools = await toolset.getTools();
```

Construct it in code when you need a stdio server:

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StdioConnectionParams',
  serverParams: {command: 'npx', args: ['-y', 'some-mcp-server']},
  timeout: 5,
});
```

## Stdio servers in agent configs

`fromConfig` throws when the config declares `stdioServerParams` or
`stdioConnectionParams` and nobody opted in. The message names the environment
variable and the alternatives.

An application that loads only agent configs it trusts opts in with the
environment variable, which is enabled when its value, lower-cased, is `true`
or `1`:

```bash
export ADK_ALLOW_CONFIG_STDIO_MCP_SERVERS=1
```

## Call guards

Every MCP call the toolset makes runs under the same three guards.

**A deadline.** `connectionParams.timeout` is a number of seconds, and the
toolset passes it to the MCP SDK as the call's request timeout. When it passes,
the SDK sends `notifications/cancelled` to the server and rejects the call.
Leave `timeout` unset to take the SDK's own default of 60 seconds.

**One retry, for the listing only.** `getTools()` retries a failed
`tools/list` once, because listing is idempotent and a dropped connection is
common. A tool call is never retried: it may already have run. A cancellation is
never retried either, and reaches the caller as the `AbortError` it was.

**A named failure.** Any other failure becomes an `McpConnectionError` whose
message names the operation and whose `cause` is the original error.

Match on the error `name` rather than on the class, so the check still holds
when two copies of the package share one runtime.

```ts
import {MCP_CONNECTION_ERROR_NAME} from '@google/adk';

const tools = await toolset.getTools().catch((error: unknown) => {
  if (error instanceof Error && error.name === MCP_CONNECTION_ERROR_NAME) {
    // message: "Failed to get tools from MCP server: <root cause>"
    // cause:   the original transport error
    return [];
  }
  throw error;
});
```

## Reserved tool names

The framework owns four function-call names: `transfer_to_agent`,
`adk_request_credential`, `adk_request_confirmation` and `adk_request_input`. A
server that advertises one of them would shadow a framework call, so
`getTools()` drops that tool and logs a warning. The rest of the listing is
unaffected. The match is on the name the server sent, before any
`toolNamePrefix` is applied.

## HTTP debug capture

While debug logging is on, the toolset records the HTTP exchanges of its own
calls onto the invocation, under `http_debug_info`. Capture is off at any other
log level: an ordinary run sends exactly the bytes it sends today and records
nothing.

```ts
import {LogLevel, setLogLevel, type HttpDebugExchange} from '@google/adk';

setLogLevel(LogLevel.DEBUG);
await toolset.getTools(readonlyContext);

const exchanges = readonlyContext.invocationContext.customMetadata[
  'http_debug_info'
] as HttpDebugExchange[];
```

What is recorded, and what is not:

- Credential-bearing headers are masked, and a credential in the URL is masked.
- A body over 1000 characters is truncated with `... [truncated]`.
- An event-stream body is recorded as `<SSE stream>` and never read, because
  reading it would starve the transport of its events.
- The sink stops at 50 exchanges per call, so a long streaming session cannot
  grow it without bound.
- A failure while recording is logged and swallowed. Recording never changes the
  outcome of a request.
