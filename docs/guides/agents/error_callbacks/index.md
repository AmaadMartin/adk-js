# Agent error callbacks

`onModelErrorCallback` and `onToolErrorCallback` let one agent answer its own
failed model call or tool call. Reach for them when a single agent needs a
fallback answer, and for an app-wide policy use a plugin instead.

## Introduction

A model call fails when the provider is down, rate-limits the request, or
rejects it. A tool call fails when the tool throws, or when the model invents a
tool name that does not exist. Without a handler the turn carries the failure
onward: the model error becomes an event with `errorCode` and `errorMessage`,
and the tool error becomes the tool's answer to the model.

Both callbacks turn that failure into a normal answer. `onModelErrorCallback`
returns an `LlmResponse` that replaces the failed model turn.
`onToolErrorCallback` returns a record that answers the tool call, so the model
sees a result instead of an error and can carry on.

These are the agent-level counterparts of the plugin hooks
`onModelErrorCallback` and `onToolErrorCallback`. The plugins run first: an
app-wide policy keeps precedence, and the agent's callbacks run only when no
plugin answered. Each side is offered the failure in order, and the first
non-nullish result wins; when every callback declines, the original failure is
reported.

## Get started

```ts
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const lookupPrice = new FunctionTool({
  name: 'lookup_price',
  description: 'Looks up the price of a product.',
  parameters: z.object({sku: z.string()}),
  execute: ({sku}) => callPricingService(sku),
});

const agent = new LlmAgent({
  name: 'resilient',
  model: 'gemini-2.5-flash',
  tools: [lookupPrice],
  onModelErrorCallback: ({error}) => ({
    content: {
      role: 'model',
      parts: [{text: `The model is unavailable: ${error.message}`}],
    },
  }),
  onToolErrorCallback: ({tool, error}) => ({
    fallback: `${tool.name} failed: ${error.message}`,
  }),
});
```

A callback may be `async`, and it may return `undefined` to decline the failure.

## Several callbacks

Pass an array to try handlers in order. Each one runs until a callback returns
a result.

```ts
const agent = new LlmAgent({
  name: 'resilient',
  model: 'gemini-2.5-flash',
  onModelErrorCallback: [
    ({error}) =>
      error.message.includes('429')
        ? {content: {role: 'model', parts: [{text: 'Please retry later.'}]}}
        : undefined,
    ({error}) => ({
      content: {role: 'model', parts: [{text: `Sorry: ${error.message}`}]},
    }),
  ],
});
```

`agent.canonicalOnModelErrorCallbacks` and
`agent.canonicalOnToolErrorCallbacks` return the normalized array, which is the
array you passed when you passed one.

## What each callback receives

`onModelErrorCallback` receives the callback `context`, the `request` that
failed, and the `error`. Reading `request` is how a handler tells one failing
model from another when an agent runs several.

`onToolErrorCallback` receives the `tool`, its `args`, the tool `context`, and
the `error`. It also runs when the model calls a tool that is not registered.
In that case `tool.name` is the name the model asked for, and the error says
the tool was not found — which is how a handler can answer with the list of
tools that do exist.

## Failure modes

- A callback that itself throws is not caught. The throw propagates out of the
  turn, so keep a handler simple.
- Returning `undefined` from every callback is the same as having none: the
  model error becomes an event carrying `errorCode` and `errorMessage`, and the
  tool error becomes `{error: <message>}` in the tool result.
- A model error that is not an `Error` instance is re-thrown untouched and no
  callback sees it.
