# Converting a session into eval invocations

`convertEventsToEvalInvocations` turns a recorded event log into the eval data
model. Each `Invocation` holds one turn: what the user asked, what the agent
finally answered, and the tool calls and sub-agent replies in between. Reach for
it when you want to promote a real conversation into a regression test, instead
of writing the expected turn by hand.

## Introduction

A `Session` stores a flat list of events. Every event of one turn shares an
`invocationId`, but the list interleaves user messages, model replies, tool
calls, tool results and sub-agent chatter. An evaluator does not want that
shape. It wants one record per turn, with the user request and the final answer
separated from the steps that produced them.

The converter does that split. It groups events by `invocationId`, picks the
user request and the final response out of each group, and keeps the remaining
events as `intermediateData.invocationEvents`. The output order follows the
order in which each invocation id first appears, so the turns stay in
conversation order.

Two rules are worth knowing, because they decide what an evaluator sees.

A live turn emits its answer twice: once as audio, once as a text transcript.
The converter prefers the text, because that is the gradable form. The audio
event still appears as an intermediate event.

The event chosen as the final response is normally dropped from
`invocationEvents`, because `finalResponse` already holds it. It is kept when it
carries a tool call or grounding metadata, which an evaluator has no other way
to read. When it is kept for grounding metadata alone, its `content` is left
undefined, so the answer is not counted twice.

The converter is pure. It reads the events, copies nothing, and returns records
that share the same `Content` objects as the source events.

## Get started

`convertSessionToEvalInvocations` is the session-level entry point. It accepts
an absent session, so you can pass the result of a lookup straight into it.

```ts
import {convertSessionToEvalInvocations} from '@google/adk-devtools';

const session = await sessionService.getSession({appName, userId, sessionId});
const invocations = convertSessionToEvalInvocations(session);

const turns = invocations.map((invocation) => ({
  question: invocation.userContent.parts?.[0].text,
  answer: invocation.finalResponse?.parts?.[0].text,
  steps: invocation.intermediateData?.invocationEvents.length ?? 0,
}));
```

Use `convertEventsToEvalInvocations` from `@google/adk` when you hold the events
already, for example when you collected them from a runner.

```ts
import {convertEventsToEvalInvocations, Event} from '@google/adk';

const events: Event[] = [];
for await (const event of runner.runAsync({userId, sessionId, newMessage})) {
  events.push(event);
}
const invocations = convertEventsToEvalInvocations(events);
```

## What each field holds

- `invocationId` - the id shared by the group. An empty id is a valid group.
- `userContent` - the content of the last user event of the turn. It is always
  present, and it is `{parts: []}` when the turn has no user event.
- `finalResponse` - the content of the last qualifying agent event. It is
  absent when the turn ended in a tool call and produced no answer.
- `intermediateData.invocationEvents` - the agent events that carry signal: a
  tool call, a tool result, text, inline data, or grounding metadata. An event
  with none of those is dropped.
- `creationTimestamp` - the timestamp of the user event, in milliseconds since
  the epoch. It is `0` when the turn has no user event.

`google/adk-python` records `creationTimestamp` in seconds, because its own
event timestamps are in seconds. adk-js keeps the unit of `Event.timestamp`, so
convert at the boundary if you write eval sets that adk-python reads.
