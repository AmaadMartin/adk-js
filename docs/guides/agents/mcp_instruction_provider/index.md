# mcpInstructionProvider

`mcpInstructionProvider` builds an `InstructionProvider` that reads an agent's
instruction from a named prompt on a Model Context Protocol (MCP) server, so
the prompt lives on that server instead of in the agent definition.

## Introduction

An `LlmAgent` accepts either a string instruction or an `InstructionProvider` —
a function the agent calls on every invocation. A string is fixed at build
time. A provider is not, so it can fetch the text from somewhere else.

MCP servers can publish prompts as well as tools and resources. A prompt has a
name, a list of declared arguments, and a handler that returns messages. Moving
an agent's instruction into an MCP prompt lets a prompt team edit and version it
without a release of the agent, and lets several agents share one prompt.

The provider fills the prompt's arguments from session state. It sends only the
keys the prompt **declares**; every other state key stays local. That boundary
matters because session state holds whatever the app and its tools have written
into it, and an agent should not leak that to a prompt server by accident. A
declared key that state does not hold is omitted rather than sent as an empty
value.

Reach for this when the prompt is owned elsewhere. When the instruction only has
to interpolate state, a plain string with `{key}` placeholders is simpler and
costs no round trip.

## Get started

```ts
import {LlmAgent, mcpInstructionProvider} from '@google/adk';

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.5-flash',
  instruction: mcpInstructionProvider(
    {
      type: 'StreamableHTTPConnectionParams',
      url: 'https://prompts.example.com/mcp',
    },
    'support_system_prompt',
  ),
});
```

A stdio server works the same way:

```ts
instruction: mcpInstructionProvider(
  {
    type: 'StdioConnectionParams',
    serverParams: {command: 'node', args: ['./prompt_server.mjs']},
  },
  'support_system_prompt',
),
```

## What one invocation does

1. Opens an MCP session through `MCPSessionManager`.
2. Calls `listPrompts()` and looks for the prompt by name.
3. Reads the declared arguments out of session state.
4. Calls `getPrompt()` with those arguments.
5. Joins the text of every text message, in server order, with no separator.
6. Closes the session.

The session manager is built once, when you call `mcpInstructionProvider`. Each
invocation opens its own session and closes it in a `finally`, so a failed call
does not leak the transport.

## Arguments

Say the server declares `support_system_prompt` with one argument, `user_name`,
and session state holds `{user_name: 'Ada', unrelated: 'x'}`. The provider sends
`{user_name: 'Ada'}`. `unrelated` is never sent.

MCP types a prompt argument as a string. A state value that is already a string
is sent unchanged; anything else is serialized with `JSON.stringify`, so
`{a: 1}` arrives as `{"a":1}`.

## Failure modes

The provider throws `Failed to load MCP prompt '<name>'.` when the prompt result
carries no messages.

A prompt name that `listPrompts()` does not advertise is **not** an error. The
provider still calls `getPrompt()`, with no arguments, because a server may
serve a prompt it does not list. If that prompt does not exist either, the
server's own error propagates.

Messages whose content is not text — an image, a resource link — are skipped. A
prompt whose messages are all non-text returns the empty string.

Errors from `createSession()`, `listPrompts()` and `getPrompt()` propagate to the
agent unchanged.

## Related

- `MCPToolset` — the same connection parameters, for a server's tools.
- `InstructionProvider` in `LlmAgent` — the function type this returns.
