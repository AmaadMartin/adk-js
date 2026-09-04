# Interactions API conversation chaining

The Interactions API keeps the conversation on the server. ADK chains each turn
onto the previous one by id, so the agent sends only the new user message
instead of the whole transcript. Reach for it when a conversation is long and
re-sending its history on every turn costs too much.

## Introduction

A normal Gemini call is stateless: `LlmRequest.contents` carries the entire
conversation, and the cost of a turn grows with the conversation. The
Interactions API stores each turn and returns an interaction id for it. Send
that id as `previousInteractionId` on the next request and the server supplies
the earlier turns itself.

Two pieces make this work in ADK. `Gemini` records the id the API returned on
`LlmResponse.interactionId`, and the runner persists the response as a session
event, so the id survives in session history. `InteractionsRequestProcessor`
then reads it back on the next turn. It is part of the default `LlmAgent`
request pipeline, so an agent needs no wiring beyond turning the API on.

The processor scans the session events in reverse and stops at the newest event
that this agent authored and that carries an interaction id. Two events are
invisible to it: an event authored by another agent, and an event that belongs
to a different branch. An event with no branch at all was appended at the
invocation root, so every branch sees it — that is what lets a sub-agent of a
`SequentialAgent` chain onto its own earlier turns.

## Get started

```ts
import {Gemini, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: new Gemini({
    model: 'gemini-2.5-flash',
    useInteractionsApi: true,
  }),
});
```

Run the agent twice in one session. On the second turn the processor finds the
first turn's interaction id, sets `previousInteractionId`, and
`generateContentViaInteractions` sends only the latest user contents.

## Branch scoping

`InvocationContext.branch` names the sub-agent path an event came from, in the
form `agent_1.agent_2`. The scan accepts an event when either rule holds:

| Current branch | Event branch | Visible |
| -------------- | ------------ | ------- |
| unset          | unset        | yes     |
| unset          | set          | no      |
| `root.child`   | `root.child` | yes     |
| `root.child`   | `root.other` | no      |
| `root.child`   | unset        | yes     |

The last row is the one that matters in a multi-agent app. Without it a
sub-agent cannot see the turns it appended at the invocation root, so the chain
breaks and the whole transcript goes out again.

## Diagnosing a broken chain

The scan logs each step at debug level: the agent and branch it starts with,
every event it skips as out of branch, every event it checks, and the id it
settles on. Raise the log level to see them.

```ts
import {LogLevel, setLogLevel} from '@google/adk';

setLogLevel(LogLevel.DEBUG);
```

## Environment ids

`LlmResponse.environmentId` holds the execution environment the interactions
API ran the turn in, and `Event` inherits the field. The API reports one only
when the request configured an environment, so it is usually absent.

A non-streaming response carries the id through
`convertInteractionToLlmResponse`, and `findPreviousInteractionState` returns
it beside the interaction id. A streaming response does not: the SDK's
`InteractionSSEEvent` declares no environment id, so there is nothing to read.
