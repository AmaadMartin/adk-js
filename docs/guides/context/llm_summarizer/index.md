# LlmSummarizer

Summarizes a slice of session events into one compacted event, using an LLM.
A context compactor calls it when the history grows too large, and appends the
summary it returns in place of the events it covers.

## Introduction

A long session eventually costs more in prompt tokens than the old turns are
worth. A context compactor decides _when_ to shrink the history and _which_
events form the window. `LlmSummarizer` decides _what the summary says_: it
renders the window as text, asks the model to summarize it, and returns a
`CompactedEvent`.

What it renders matters as much as the model it calls. An agent that works
through tools produces a transcript that is mostly tool traffic, and a summary
built from plain text parts alone loses the tool names and the evidence they
returned. `LlmSummarizer` renders four kinds of part:

| Part                      | Rendered as                         |
| ------------------------- | ----------------------------------- |
| text                      | `author: text`                      |
| text with `thought: true` | `author (thought): text`            |
| `functionCall`            | `author called tool: name(args)`    |
| `functionResponse`        | `Tool response from name: response` |

Tool arguments and tool responses are JSON, and a search result can be large,
so each one is capped at 2000 characters and marked
`... [truncated N chars]`. Thought parts that belong to a compacted event are
skipped, so a previous summary's reasoning does not leak into the next one.

`LlmSummarizer` implements [`BaseSummarizer`](../summarizer/index.md), so any
of the three compactors — `TokenBasedContextCompactor`,
`AnchoredContextCompactor` and `AgentControlledContextCompactor` — accepts it.
Write your own summarizer when you want a different summary; keep this one when
you only want a different prompt.

## Get started

Give the summarizer a model, give a compactor the summarizer, and give the
agent the compactor.

```ts
import {
  Gemini,
  LlmAgent,
  LlmSummarizer,
  TokenBasedContextCompactor,
} from '@google/adk';

const compactor = new TokenBasedContextCompactor({
  tokenThreshold: 40_000,
  eventRetentionSize: 2,
  summarizer: new LlmSummarizer({
    llm: new Gemini({model: 'gemini-2.5-flash'}),
  }),
});

export const rootAgent = new LlmAgent({
  name: 'compaction_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant that answers concisely.',
  contextCompactors: [compactor],
});
```

The compactor runs between invocations. When the last observed request exceeded
`tokenThreshold`, it summarizes everything except the last
`eventRetentionSize` events and appends the result to the session.

## The prompt

The default prompt asks the model to restate the user request, summarize the
context, name the conversation language, and list the exact tool names it saw.
The rendered history is substituted into the `{conversation_history}`
placeholder.

Pass your own `prompt` to replace it:

```ts
const summarizer = new LlmSummarizer({
  llm: new Gemini({model: 'gemini-2.5-flash'}),
  prompt:
    'Summarize this conversation in three bullet points.\n\n' +
    '{conversation_history}',
});
```

A prompt with no `{conversation_history}` placeholder still works: the history
is appended after it, separated by a blank line.

## What you get back

`summarize()` resolves to a `CompactedEvent` whose `compactedContent` is the
summary text, whose `content` carries the same text with `role: 'model'`, and
whose `startTime` and `endTime` are the timestamps of the first and last event
in the window. The event's author is `'user'`.
`AnchoredContextCompactor` overwrites that author with `'system'`, because it
marks its summary as the session scratchpad.

The `usageMetadata` of the model response is copied onto the event, so the
tokens compaction itself spends stay visible in the session.

`summarize()` declines with `null` in two cases: the event list is empty, in
which case it does not call the model at all, and the model returns no text.
An error thrown by the model is not caught here; it propagates to the compactor.
See [BaseSummarizer](../summarizer/index.md) for what each compactor does with
those three outcomes.
