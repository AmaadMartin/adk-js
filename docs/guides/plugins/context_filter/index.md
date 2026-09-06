# Context filter plugin

`ContextFilterPlugin` shrinks the conversation that one model request carries. Reach for it when a long chat grows past your token budget, and you want the recent turns rather than all of them.

## Introduction

An agent resends its whole history on every turn. The request therefore grows with the conversation, and a long session eventually costs more than it is worth. The obvious remedy is to drop the oldest turns, but a naive cut breaks the history: it can keep a `functionResponse` whose `functionCall` it just dropped, and the model then reads an answer to a question it cannot see.

The plugin cuts on invocation boundaries and keeps every call paired with its response. An invocation starts at a human message and runs until the next one. It can hold many model turns, so one invocation is a whole tool-calling exchange rather than a single message. Tool output carries `role: 'user'` as well, so the plugin ignores any user content that holds a `functionResponse`. A run of consecutive human messages starts one invocation, not several.

The plugin rewrites one `LlmRequest` and nothing else. The session keeps every event, so the dropped turns are still in your history and still reach a later request if you remove the plugin.

It applies two independent filters, in this order.

1. It keeps the last `numInvocationsToKeep` invocations.
2. It passes the survivors through your `customFilter`.

## Get started

Register the plugin on the runner and set how many invocations to keep.

```typescript
import {ContextFilterPlugin, InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  agent: new LlmAgent({name: 'chat', model: 'gemini-2.5-flash'}),
  plugins: [new ContextFilterPlugin({numInvocationsToKeep: 3})],
});

const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: 'user-1',
});

const events = [];
for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'What did we decide?'}]},
})) {
  events.push(event);
}
```

## The truncation threshold

Truncation does not start at `numInvocationsToKeep`. It starts once the conversation holds `numInvocationsToKeep + removeAmount` invocations, and `removeAmount` defaults to 1. Below that threshold the request passes through untouched.

```typescript
new ContextFilterPlugin({numInvocationsToKeep: 3, removeAmount: 5});
```

That plugin leaves a conversation alone until it reaches 8 invocations, then cuts it back to 3. A larger `removeAmount` therefore trims less often and drops more each time, which suits a cached prefix that you do not want invalidated on every turn.

Leave `numInvocationsToKeep` undefined, or set it to 0 or less, to skip truncation. A `customFilter` still runs.

`removeAmount` must be at least 1. The constructor throws for anything lower.

## Function calls keep their responses

Before it cuts, the plugin walks left from the candidate index until no kept `functionResponse` is missing its `functionCall`. The two are matched on `id`, and a call or a response without an `id` is ignored by the walk.

This matters for a long-running tool, whose response can arrive one invocation after its call. Keeping the last invocation alone would orphan that response, so the split moves left far enough to keep the call as well. When a response can never be paired, the plugin keeps the whole conversation rather than shipping an orphan.

## The custom filter

`customFilter` receives the truncated array and returns the array to send. It is synchronous, and its return value is used as it stands, including an empty array.

```typescript
new ContextFilterPlugin({
  numInvocationsToKeep: 3,
  customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
});
```

The custom filter runs after truncation, so it sees the kept window rather than the full history. It also runs on its own when you set no `numInvocationsToKeep`.

Nothing checks what your filter returns. A filter that drops a `functionCall` and keeps its `functionResponse` undoes the pairing guarantee above.

## Failures

The plugin never blocks the model call. A throw inside the callback is caught and logged, the request keeps the contents it already had, and the call proceeds. A broken `customFilter` therefore costs you the filtering, not the turn.
