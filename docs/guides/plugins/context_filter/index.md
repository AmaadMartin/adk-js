# ContextFilterPlugin

`ContextFilterPlugin` trims the conversation history that one model call sees. It keeps the last N invocations, then applies an optional filter of your own. Reach for it when a long chat outgrows the model's context window but you still want the full history on disk.

## Introduction

An agent sends its whole session history to the model on every turn. A long conversation therefore costs more tokens each turn, and eventually exceeds the window. This plugin shortens the request instead of the session.

The plugin hooks `beforeModelCallback` and rewrites `llmRequest.contents`. It writes nothing to the session, emits no event, and always returns `undefined`, so the model call proceeds normally. Register it once on a runner and every agent in that app gets the shorter request.

This is not the same layer as the compactors in `core/src/context/`. A compactor rewrites `session.events`, so its effect is permanent and visible to every later turn. This plugin edits one request and forgets it. Use a compactor to shrink stored history; use this plugin to shrink what one call sends.

## Get started

Register the plugin on your runner alongside the agent.

```typescript
import {ContextFilterPlugin, InMemoryRunner, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'chat_agent',
  model: 'gemini-2.0-flash',
  instruction: 'You are a helpful assistant.',
});

const runner = new InMemoryRunner({
  agent,
  plugins: [new ContextFilterPlugin({numInvocationsToKeep: 1})],
});
```

On the first two turns the model sees the whole history. On the third turn the history holds three invocations, so the plugin truncates: the model receives only the third user message. The session still holds all three turns.

## What counts as an invocation

An invocation begins at a message from the human user. That means `role: 'user'` on a content that carries no `functionResponse` part.

Tool output also carries `role: 'user'`, and it must not begin an invocation. If it did, every tool call would push a real turn out of the window. Consecutive user messages belong to one invocation, so a user who sends two messages in a row still gets one.

## removeAmount is hysteresis, not a delete count

`removeAmount` does not say how many invocations to remove. Truncation always keeps exactly `numInvocationsToKeep` invocations and drops everything before them.

What `removeAmount` decides is _when_ truncation runs. The plugin truncates only once the history holds `numInvocationsToKeep + removeAmount` invocations. A larger value therefore truncates less often, in bigger steps. That suits a cached prompt prefix, because every cut invalidates the cache.

```typescript
// Keep 3 invocations, but only re-truncate once 5 have accumulated.
new ContextFilterPlugin({numInvocationsToKeep: 3, removeAmount: 2});
```

`removeAmount` defaults to 1 and must be at least 1. The constructor throws `Error('removeAmount must be at least 1.')` otherwise.

## Function calls stay paired

Most models reject a `functionResponse` whose matching `functionCall` is missing. A plain cut at an invocation boundary can produce exactly that, because a call made in one invocation can be answered after the next user message arrives.

The plugin moves the cut point left until every kept `functionResponse` id has its `functionCall` id in the kept range. If no such point exists, it keeps the whole history rather than sending a broken request. A `functionCall` or `functionResponse` without an id takes no part in this check.

## Filtering with your own function

`customFilter` receives whatever survived truncation and returns the contents to send. It runs after truncation, never before.

```typescript
new ContextFilterPlugin({
  numInvocationsToKeep: 3,
  customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
});
```

The filter is synchronous, and it may return an empty array. Note that the plugin does not re-check function call pairing on what your filter returns.

## Failures leave the request alone

The plugin wraps the whole callback in one `try`/`catch`. If your filter throws, or the truncation logic throws, the plugin logs the error through `logger.error` and leaves `llmRequest.contents` exactly as it found it. The model call then proceeds with the full history. A broken filter costs you tokens, not the turn.

## Options

| Option                 | Type                                 | Default                   | Description                                                                        |
| :--------------------- | :----------------------------------- | :------------------------ | :--------------------------------------------------------------------------------- |
| `numInvocationsToKeep` | `number`                             | `undefined`               | Invocations to retain. Undefined, 0 or less skips truncation.                      |
| `customFilter`         | `(contents: Content[]) => Content[]` | `undefined`               | Applied after truncation.                                                          |
| `name`                 | `string`                             | `'context_filter_plugin'` | Plugin instance name.                                                              |
| `removeAmount`         | `number`                             | `1`                       | Extra invocations that must accumulate before truncation runs. Must be at least 1. |
