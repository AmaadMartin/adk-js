# Tool error telemetry

`detectErrorInResponse` lets a tool tell the trace that a result it returned
is a failure. Reach for it when your tool reports a failure by returning it,
rather than by throwing.

## Introduction

A tool reports a failure in one of two ways. It throws, or it returns a value
that describes the failure. ADK records the first one on the tool's
`execute_tool` span. It cannot record the second, because a returned value is
an ordinary result as far as the runtime is concerned.

That gap matters most for remote tools. An MCP server answers a failed call
with a `CallToolResult` whose `isError` is true. The request succeeded, so the
span shows a healthy call. A dashboard counting failed tool calls counts none
of them.

`BaseTool.detectErrorInResponse` closes the gap. A tool that implements it
classifies its own responses, and ADK copies the classification onto the span
as the `error.type` attribute. The hook is optional: a tool that does not
implement it reports no error type, rather than inheriting a classification
that does not fit it.

## Get started

Implement the hook on your tool. Return a short, stable string for a failed
response, and `undefined` for a successful one.

```ts
import {BaseTool, RunAsyncToolRequest} from '@google/adk';

class ChargeCardTool extends BaseTool {
  constructor() {
    super({name: 'charge_card', description: 'Charges a saved card.'});
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return {declineCode: 'insufficient_funds', args: request.args};
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    return typeof response === 'object' &&
      response !== null &&
      'declineCode' in response
      ? 'CARD_DECLINED'
      : undefined;
  }
}
```

A call that returns a decline now records `error.type: 'CARD_DECLINED'` on its
span, and the span status becomes `ERROR` with the same string as its message.
A call that returns anything else records neither.

`MCPTool` implements the hook already. It reports `'MCP_TOOL_ERROR'` for a
result the MCP server marked with `isError`, so you get this on every MCP tool
without writing anything.

## What ADK records

| Response                             | `error.type` | Span status                     |
| ------------------------------------ | ------------ | ------------------------------- |
| The detector returns a string        | That string  | `ERROR`, message is that string |
| The detector returns `undefined`     | Not set      | `UNSET`                         |
| The tool does not implement the hook | Not set      | `UNSET`                         |

The span status is set as well as the attribute. Without it the span renders
as successful, which hides the very calls the attribute exists to surface.

## Guarantees

**The detector must not modify the response.** ADK passes the value the tool
resolved with, not a copy. The value continues to the model after detection
runs.

**A detector that throws cannot break the tool call.** ADK logs the failure
through `logger.error` and treats it as "no error type". The tool's own result
is returned unchanged.

**Detection is skipped while the tool waits on the user.** A tool that asks
for a credential or for confirmation returns a response carrying an `error`
key, without having failed. ADK skips detection whenever the call requested
either, so a pending handshake never marks the span as failed.

## Choosing an error type

The string lands in a span attribute that people group and count by, so treat
it as an enumeration rather than a message.

- Use a small, fixed set of values. `'CARD_DECLINED'` groups; `'card declined
for user 4821'` does not.
- Put no user content and no credentials in it. The value is not covered by
  the switch that gates request and response content on spans.
- Keep a value stable once you ship it. Renaming one breaks the dashboards
  built on it.
