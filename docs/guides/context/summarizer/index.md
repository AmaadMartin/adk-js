# BaseSummarizer

The strategy a context compactor uses to turn a window of session events into
one summary event. Implement `BaseSummarizer` when you want to control how a
long conversation is condensed, or when you want a compactor to sometimes leave
the history alone.

## Introduction

A context compactor decides _when_ to compact and _which_ events form the
window. It does not decide what the summary says. That is the summarizer's job,
and the two are separate so you can change one without the other.

`adk-js` ships `LlmSummarizer`, which sends the window to a model and wraps the
reply in a `CompactedEvent`. Three compactors consume a summarizer:
`TokenBasedContextCompactor`, `AnchoredContextCompactor`, and
`AgentControlledContextCompactor`.

`summarize` returns `Promise<CompactedEvent | null>`, so a summarizer has three
outcomes rather than two:

| Result             | What the compactor does                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| A `CompactedEvent` | Installs the summary and drops or supersedes the window.                              |
| `null`             | Leaves `session.events` exactly as it found it.                                       |
| A thrown error     | Propagates, except in `AgentControlledContextCompactor`, which logs it and continues. |

`null` is a declined compaction, not a failure. Use it when there is nothing
worth summarizing, or when compacting now would cost more than it saves. Throw
only when something actually went wrong.

The interface is marked `@experimental`; its shape can change in a minor
release.

## Get started

A summarizer that declines while the window is small, and delegates to
`LlmSummarizer` otherwise.

```ts
import {
  BaseSummarizer,
  CompactedEvent,
  Event,
  LlmSummarizer,
  TokenBasedContextCompactor,
} from '@google/adk';

const MIN_EVENTS_TO_SUMMARIZE = 4;

class BudgetAwareSummarizer implements BaseSummarizer {
  constructor(private readonly delegate: LlmSummarizer) {}

  async summarize(events: Event[]): Promise<CompactedEvent | null> {
    if (events.length < MIN_EVENTS_TO_SUMMARIZE) {
      return null;
    }
    return this.delegate.summarize(events);
  }
}

const compactor = new TokenBasedContextCompactor({
  tokenThreshold: 8000,
  eventRetentionSize: 4,
  summarizer: new BudgetAwareSummarizer(new LlmSummarizer({llm: myLlm})),
});
```

When `BudgetAwareSummarizer` returns `null`, the compactor appends nothing and
the run continues on the full history. It will be asked again on the next
invocation that crosses the threshold.

## What a compactor guarantees on null

Each compactor reaches `null` at a different point, so what "unchanged" means is
worth stating per compactor.

- `TokenBasedContextCompactor` appends no event. The history keeps its length
  and order, and an earlier `CompactedEvent` in the history is not touched.
- `AnchoredContextCompactor` returns before it rebuilds `session.events`. An
  existing scratchpad event stays in place with its original content.
- `AgentControlledContextCompactor` appends no event, and still clears the
  `temp:consolidate_context` and `temp:consolidate_context_detail` state keys.
  A declined compaction does not leave the agent asking for one forever.

## Writing the CompactedEvent

Build the success result on top of `createEvent`, then add the four fields
`CompactedEvent` adds to `Event`:

```ts
import {CompactedEvent, Event, createEvent} from '@google/adk';

function buildSummary(events: Event[], summaryText: string): CompactedEvent {
  return {
    ...createEvent({
      author: 'system',
      content: {role: 'model', parts: [{text: summaryText}]},
    }),
    isCompacted: true,
    startTime: events[0].timestamp,
    endTime: events[events.length - 1].timestamp,
    compactedContent: summaryText,
  };
}
```

`AnchoredContextCompactor` overwrites `author` and sets `isScratchpad` itself,
so a summarizer used only there does not need to set them.

## Differences from adk-python

`adk-python` calls the same abstraction `BaseEventsSummarizer` and its method
`maybe_summarize_events`, and returns `Optional[Event]` where the summary
carries an `EventCompaction` in `actions`. `adk-js` returns a distinct
`CompactedEvent` type with its own `isCompacted` / `startTime` / `endTime`
fields and type guards. The `null` contract is the same in both.

One behaviour still differs: `LlmSummarizer` throws on an empty event list and
on a model reply with no content, where `adk-python`'s `LlmEventSummarizer`
returns `None` for both.
