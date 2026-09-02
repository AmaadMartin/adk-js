# Events compaction

`App.eventsCompactionConfig` declares one compaction policy for every agent in
an app. Reach for it when a conversation grows long enough that the prompt
approaches the model's context window, and you would rather summarize the old
turns than lose them.

## Introduction

A session keeps every event. The content processor turns those events into the
model request, so a long session means a large prompt: slower calls, higher
cost, and eventually a request the model rejects. Compaction replaces a range
of old events with one summary event, leaving the recent turns raw.

ADK has two places to declare that policy.

- An agent can carry its own `contextCompactors`. Each compactor decides when
  it should run and what it summarizes. This is the finer-grained option: two
  agents in one app can compact differently.
- An app can carry `eventsCompactionConfig`. Every agent under the app that
  declares no compactors of its own uses it.

The agent wins where both are set. The app-level policy is a default, not an
override, so adding one to an existing app does not change an agent that
already manages its own compaction.

`adk-python` names the same field `events_compaction_config` and applies the
same precedence. Both SDKs support two triggers, and they fire in different
places. The token trigger runs *inside* an invocation, before the contents are
built. The sliding-window trigger runs *after* the invocation, once every event
of the turn has been handed to the caller.

## Get started

```typescript
import {
  App,
  InMemoryRunner,
  LlmAgent,
  createEventsCompactionConfig,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.0-flash',
  instruction: 'Answer the user.',
});

const app = new App({
  name: 'assistant_app',
  rootAgent: agent,
  eventsCompactionConfig: createEventsCompactionConfig({
    // Compact once the measured prompt passes 8000 tokens.
    tokenThreshold: 8000,
    // Always leave the 10 most recent events raw.
    eventRetentionSize: 10,
  }),
});

const runner = new InMemoryRunner({app});
```

The `Runner` copies the policy onto every invocation it starts. Compaction runs
before the contents are built, so the very request that would have been too
large is the one that carries the summary.

## Configuration

`createEventsCompactionConfig` validates the policy and returns it.

| Field                | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `tokenThreshold`     | The prompt size, in tokens, at which compaction runs. At least 1. |
| `eventRetentionSize` | How many recent events stay raw. At least 0.                      |
| `summarizer`         | Turns a range of events into the summary event. Optional.         |
| `compactionInterval` | Sliding-window trigger: compact every N invocations. At least 1.  |
| `overlapSize`        | Sliding-window trigger: invocations to re-include. At least 0.    |

Each trigger is a pair, and you set a pair together or not at all. A policy
with no trigger at all is rejected, as is one that sets half a pair.

Omit `summarizer` and the compaction uses an `LlmSummarizer` over the running
agent's own model. Supply one to control the prompt or to summarize with a
cheaper model:

```typescript
import {LlmSummarizer, createEventsCompactionConfig} from '@google/adk';

createEventsCompactionConfig({
  tokenThreshold: 8000,
  eventRetentionSize: 10,
  summarizer: new LlmSummarizer({
    llm: cheapModel,
    prompt: 'Summarize the conversation in five bullet points.',
  }),
});
```

## The sliding-window trigger

Set `compactionInterval` and `overlapSize` to compact by whole turns instead of
by prompt size. The runner counts the invocations that arrived since the last
summary. Once that count reaches `compactionInterval`, it summarizes them
together with the `overlapSize` invocations before them, so consecutive
summaries share context.

```typescript
import {
  App,
  InMemoryRunner,
  LlmAgent,
  createEventsCompactionConfig,
} from '@google/adk';

const app = new App({
  name: 'chat_app',
  rootAgent: new LlmAgent({
    name: 'assistant',
    model: 'gemini-2.0-flash',
    instruction: 'Answer the user.',
  }),
  eventsCompactionConfig: createEventsCompactionConfig({
    // Summarize after every second turn.
    compactionInterval: 2,
    // Re-read the turn before the window, so the summaries overlap.
    overlapSize: 1,
  }),
});

const runner = new InMemoryRunner({app});
```

The runner appends the summary to the session after the last event of the turn
has been yielded, so `runAsync` completes only once the summary is stored. The
next request reads it back through the same reader the token trigger writes
for: the summary replaces the raw events it covers, and the turns after it stay
raw.

Both triggers may be set on one policy. They are independent, so a long single
turn is served by the token trigger while a long conversation of short turns is
served by the window.

## What it guarantees

- **Compaction runs at most once per invocation.** A long invocation can make
  several model calls; the token trigger fires on the first call that crosses
  the threshold and stands down for the rest. Without that, each call would
  summarize the history again.
- **A tool call is never split from its response.** The token trigger grows the
  retained range backwards rather than cutting between the two. The
  sliding-window trigger trims its window to the last point where nothing is
  outstanding, so a turn that ended awaiting a tool, a confirmation or user
  input keeps its unanswered call raw until the answer arrives.
- **Nothing is deleted.** The summary event is appended, and the events it
  covers stay in the session. Later compactions fold the previous summary in.
- **A summary that loses a write race is dropped, not forced.** A second turn
  can advance the session while the summarizer is still running. The runner
  discards the late summary rather than overwriting the newer history, and the
  invocation still succeeds.

## Failure modes

- An `eventsCompactionConfig` that configures no trigger, or half of one,
  throws when the `App` is built.
- A bare node run as the app root has no model. With no `summarizer` in the
  policy there is nothing to summarize with, so compaction does not run.
- A session whose events carry no `usageMetadata.promptTokenCount` falls back
  to a character-count estimate of the contents. The estimate cannot see the
  system instruction or the tool schemas, so it reads low.
