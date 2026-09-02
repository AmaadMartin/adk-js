# Recovering from a model error

`LlmAgent.onModelErrorCallback` runs when the model call throws. A callback can
return an `LlmResponse` to stand in for the failed turn, so the caller sees a
reply rather than an error event. Reach for it when one agent needs a fallback
and you do not want to write a plugin for it.

## Introduction

A model call fails for reasons the agent cannot prevent: a rate limit, a
transport error, a safety refusal encoded as an error. ADK turns the failure
into an event carrying `errorCode` and `errorMessage`, which is honest but
rarely what a user should read.

Three things can answer that failure, in a fixed order:

1. The plugin manager's `onModelError` callbacks. A plugin serves the whole
   app, so it goes first. `ReflectAndRetryModelPlugin` lives here.
2. This agent's `onModelErrorCallback`. It serves one agent, which is what you
   want when only one agent in a tree needs the fallback.
3. The built-in error event, when neither returned anything.

The first response wins and the rest are skipped. That is the same rule
`beforeModelCallback` and `afterModelCallback` follow, so the three callbacks
behave alike.

Choose a plugin when every agent should recover the same way. Choose this
callback when one agent should, because a plugin that special-cases one agent
by name is harder to read than a callback attached to it.

## Get started

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  onModelErrorCallback: ({error}) => {
    if (!error.message.includes('429')) {
      return undefined;
    }
    return {
      content: {
        role: 'model',
        parts: [{text: 'I am busy right now. Please ask again in a minute.'}],
      },
    };
  },
});
```

Returning `undefined` declines the error, and the agent reports it as before.

## Callbacks in a list

`onModelErrorCallback` also takes an array. ADK calls the callbacks in order
and stops at the first one that returns a response.

```ts
import {LlmAgent, SingleOnModelErrorCallback} from '@google/adk';

const rateLimited: SingleOnModelErrorCallback = ({error}) =>
  error.message.includes('429')
    ? {content: {role: 'model', parts: [{text: 'Too busy, try again.'}]}}
    : undefined;

const anythingElse: SingleOnModelErrorCallback = () => ({
  content: {role: 'model', parts: [{text: 'Something went wrong.'}]},
});

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  onModelErrorCallback: [rateLimited, anythingElse],
});
```

## What the callback receives

| Field     | What it holds                                                |
| --------- | ------------------------------------------------------------ |
| `context` | The callback context, including the event actions and state. |
| `request` | The `LlmRequest` that failed. Do not reuse it to retry.      |
| `error`   | The `Error` the model threw.                                 |

## Limits

- A throw that is not an `Error` propagates untouched. The callbacks do not
  run, because there is nothing well-formed to hand them.
- The callback does not retry the model. Returning a response ends the turn;
  use `ReflectAndRetryModelPlugin` when you want another attempt.
- An error the callback itself throws is not caught here.
