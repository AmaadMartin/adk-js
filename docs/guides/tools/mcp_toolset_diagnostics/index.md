# Diagnosing an MCPToolset

Tells you which MCP call failed, where the server's own output goes, and what
went over the wire. Reach for this when an MCP tool misbehaves and the error
message alone does not say why.

## Introduction

An `MCPToolset` talks to a separate process or a remote service, so a failure
arrives as a transport error with no indication of what ADK was doing at the
time. Three pieces of diagnostic support close that gap, and they answer
different questions.

`McpConnectionError` answers "which call failed". Every toolset method rejects
with it, and the message names the MCP operation. The original error stays on
`cause`, so nothing is lost.

The `errlog` option answers "what did the server say". A stdio MCP server is a
child process that writes to its own stderr, and background transport errors
reach no caller at all. Both go to the stream you supply, instead of to the
parent process's stderr and the ADK logger.

The HTTP debug capture answers "what went over the wire". With debug logging
on, the HTTP exchanges behind a call are recorded on the invocation, headers
redacted. It only applies to `StreamableHTTPConnectionParams`; a stdio server
speaks no HTTP.

## Get started

Every rejection names its operation, with no configuration needed.

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
});

try {
  await toolset.getTools();
} catch (err) {
  // message: 'Failed to get tools from MCP server: <root cause>'
  // cause:   the transport error that actually failed
  reportToOperator(err);
}
```

The operation prefixes are the same strings adk-python uses, so a log search
works against either SDK:

| Method                             | Prefix                                          |
| ---------------------------------- | ----------------------------------------------- |
| `getTools`                         | `Failed to get tools from MCP server`           |
| `listResources`, `getResourceInfo` | `Failed to list resources from MCP server`      |
| `readResource`                     | `Failed to get resource <name> from MCP server` |

A cancelled call is the one exception. An `AbortError` reaches you unchanged,
so you can still tell "the caller gave up" apart from "the server broke".

## Capturing the server's output

Pass any writable stream as `errlog`. The toolset then asks a stdio server to
pipe its stderr, and forwards every chunk to your stream.

```ts
import {MCPToolset} from '@google/adk';
import {createWriteStream} from 'node:fs';

const errlog = createWriteStream('mcp-server.log', {flags: 'a'});

const toolset = new MCPToolset(
  {
    type: 'StdioConnectionParams',
    serverParams: {command: 'npx', args: ['-y', 'some-mcp-server']},
  },
  [],
  undefined,
  {errlog},
);
```

Background transport errors go to the same stream, prefixed
`MCP transport error:`. Without `errlog` they go to `logger.error` and the
server's stderr is inherited by the parent process, which is the previous
behaviour.

The pipe is detached when the session closes, so a long-lived toolset does not
accumulate listeners.

## Reading the HTTP exchanges

Two things have to be true before anything is recorded: debug logging is on,
and you passed a `ReadonlyContext` to the toolset method. Both are deliberate
— the capture costs a body read per request, and it needs somewhere to put the
result.

```ts
import {LogLevel, MCPToolset, setLogLevel} from '@google/adk';

setLogLevel(LogLevel.DEBUG);

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
});

await toolset.getTools(readonlyContext);

const exchanges = readonlyContext.invocationContext.customMetadata[
  'http_debug_info'
] as Array<Record<string, unknown>>;
```

Each entry holds `url`, `method`, `statusCode`, `requestHeaders`,
`responseHeaders`, `responseBody` and, when the request had a textual body,
`requestBody`. `listResources`, `getResourceInfo` and `readResource` take the
same optional context argument as `getTools`.

What the capture guarantees:

- **Credentials are removed.** The value of `authorization`, `cookie`,
  `set-cookie`, `proxy-authorization`, `api-key`, `x-api-key` and
  `x-goog-api-key` is replaced with `<redacted>` as each exchange is recorded,
  not when it is read. The record can safely be written to session storage.
- **Bodies are bounded.** A body over 1000 characters is truncated with a
  `... [truncated]` marker.
- **The list is bounded.** One invocation keeps at most 100 exchanges. Later
  calls append to the list; the overflow is dropped.
- **A streaming response is not consumed.** A `text/event-stream` body is
  recorded as `<SSE stream>`, because reading it would take it away from the
  transport.
- **A failed call is still recorded.** The exchanges captured before the
  rejection reach the invocation, which is when they are most useful.

Two captures never see each other's entries: the buffer is scoped to the async
context of one call, so concurrent agents stay separate.

If you supply your own `transportOptions.fetch`, it is still called. The
toolset wraps it rather than replacing it.
