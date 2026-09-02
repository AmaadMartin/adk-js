# RestApiTool request timeouts

Every request a `RestApiTool` sends carries a deadline. Reach for the `timeout`
option when the endpoint you call is slower, or must fail faster, than the
defaults allow.

## Introduction

A tool call runs inside an agent invocation, and the invocation waits for it. A
peer that accepts the connection and then never answers therefore holds the
invocation open for as long as the process lives. The deadline turns that hang
into a bounded failure that the model can act on.

The budgets mirror `httpx.Timeout` in adk-python, so an API gets the same amount
of time from either SDK. `fetch` aborts a whole request rather than one phase of
it, so `RestApiTool` sums the phases that run in sequence into one deadline:
`poolMs + connectMs + max(readMs, writeMs)`. With the defaults that is 620 000
milliseconds.

Tools that `OpenAPIToolset` builds use the defaults, as they do in adk-python.
Construct a `RestApiTool` yourself to change them.

## Get started

```ts
import {RestApiTool} from '@google/adk';

const tool = new RestApiTool(
  'get_item',
  'Reads one item.',
  {baseUrl: 'https://api.example.com', path: '/items/{item_id}', method: 'get'},
  {responses: {}},
  undefined,
  undefined,
  {timeout: {connectMs: 2_000, readMs: 30_000}},
);
```

The two phases you do not name keep their defaults. This tool aborts after
`10_000 + 2_000 + max(30_000, 600_000)` milliseconds.

## The budgets

| Phase       | Default | Covers                                  |
| ----------- | ------- | --------------------------------------- |
| `poolMs`    | 10 000  | Waiting for a connection from the pool. |
| `connectMs` | 10 000  | Opening the connection.                 |
| `readMs`    | 600 000 | Waiting for response bytes.             |
| `writeMs`   | 600 000 | Sending the request body.               |

Connection setup stays short so an unreachable peer fails fast. The transfer
budgets stay generous, because a legitimate API can be slow.

Read the defaults, or compute a deadline, with the exported helpers:

```ts
import {DEFAULT_REQUEST_TIMEOUT, requestDeadlineMs} from '@google/adk';

requestDeadlineMs(DEFAULT_REQUEST_TIMEOUT); // 620000
```

A budget must be a finite number of milliseconds above zero. The constructor
throws on anything else, naming the phase, because the value comes from your
application rather than from the model.

## What the model sees

A request that hits its deadline returns an error object rather than throwing.
The message is the one adk-python returns, so a model behaves the same against
either SDK:

```
Tool get_item execution failed. Analyze this execution error and your inputs.
Retry with adjustments if applicable. But make sure don't retry more than 3
times. Execution Error: Request timed out (TimeoutError).
```

The name in the parentheses is the timeout the transport reported.
`TimeoutError` is the deadline expiring; `ConnectTimeoutError`,
`HeadersTimeoutError` and `BodyTimeoutError` come from Node's HTTP client. Every
other failure keeps the existing `Failed to execute API call: <message>` result.

The tool also logs one warning naming itself, the method and the path. The query
string is left out of the log, because an `apiKey` scheme with `in: query` puts
a credential there.
