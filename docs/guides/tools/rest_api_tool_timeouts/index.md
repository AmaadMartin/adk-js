# RestApiTool request timeouts

Every request a `RestApiTool` sends carries a deadline. Reach for the
`timeoutMs` option when the endpoint you call is slower, or must fail faster,
than the default allows.

## Introduction

A tool call runs inside an agent invocation, and the invocation waits for it. A
peer that accepts the connection and then never answers therefore holds the
invocation open for as long as the process lives. The deadline turns that hang
into a bounded failure that the model can act on.

The default is 620 000 milliseconds. That is the sum of the sequential budgets
adk-python gives its client: 10 000 waiting for a pooled connection, 10 000
opening it, then 600 000 for the longer of reading and writing. An API therefore
gets the same amount of time from either SDK. `fetch` aborts a whole request
rather than one phase of it, so adk-js applies one deadline instead of four.

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
  {timeoutMs: 30_000},
);
```

This tool aborts a call that has not finished after 30 seconds. Read the default
from `DEFAULT_REQUEST_TIMEOUT_MS`:

```ts
import {DEFAULT_REQUEST_TIMEOUT_MS} from '@google/adk';

DEFAULT_REQUEST_TIMEOUT_MS; // 620000
```

`AbortSignal.timeout` rejects a negative or non-finite deadline, so an invalid
`timeoutMs` throws on the first call rather than disabling the deadline.

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
