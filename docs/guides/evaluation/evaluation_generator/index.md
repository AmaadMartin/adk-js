# Generating eval inferences

The evaluation generator produces the data an evaluator grades. It drives an
agent through a conversation, collects the `Event` stream that comes out, and
turns it into one `Invocation` per turn. Reach for it when you need to know
what an agent actually did — the user turn, the final answer, and every tool
call in between — as data rather than as a log.

## Introduction

An evaluator scores an `Invocation`: it compares the final response against a
reference, or checks that the tool trajectory matches the one you expect. It
does not run your agent. Something has to run the agent first and shape the
result, and that is what this module does.

The unit it produces is the invocation, not the event. A single user turn can
produce a dozen events — a tool call, a tool response, a sub-agent reply, a
final summary — and an evaluator needs them grouped and labelled: this is the
user turn, this is the answer, these are the steps taken to reach it.
`convertEventsToEvalInvocations` performs that grouping, keyed on the
invocation id the runner assigns.

There are two ways in. `generateInferencesFromRootAgent` runs the agent now: a
`UserSimulator` supplies each user turn and decides when the conversation ends,
so a multi-turn eval case needs no recorded script.
`convertEventsToEvalInvocations` works from events you already have, so a
session recorded in production can be graded without running anything.

The generator also records what each agent was _shown_. Autorater metrics grade
against the instructions and the tool declarations that reached the model, and
those live on the request, which never comes back to the caller.
`RequestIntercepterPlugin` is installed on the eval runner to capture them, and
`getAppDetailsByInvocationId` reads them back into `Invocation.appDetails`.

## Get started

Drive an agent through a two-turn conversation and inspect what it produced.

```typescript
import {
  Event,
  LlmAgent,
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
  generateInferencesFromRootAgent,
} from '@google/adk';

/** Replays a fixed list of user turns, then ends the conversation. */
class ScriptedUserSimulator implements UserSimulator {
  private turn = 0;

  constructor(private readonly messages: string[]) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    if (this.turn >= this.messages.length) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    const text = this.messages[this.turn];
    this.turn++;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text}]},
    };
  }
}

const invocations = await generateInferencesFromRootAgent({
  rootAgent: new LlmAgent({
    name: 'weather_agent',
    model: 'gemini-flash-latest',
    instruction: 'answer weather questions',
  }),
  userSimulator: new ScriptedUserSimulator([
    'what is the weather?',
    'and the temperature?',
  ]),
  initialSession: {appName: 'weather_app', userId: 'u1', state: {}},
});

// invocations[0].userContent  -> 'what is the weather?'
// invocations[0].finalResponse -> the agent's answer to it
// invocations[0].intermediateData.invocationEvents -> the steps it took
```

The simulator receives a deep copy of the conversation so far on every call, so
it cannot disturb the record the generator keeps.

## Grading a recorded session

`convertEventsToEvalInvocations` takes an event stream and returns the same
invocations, with no agent run and no model call.

```typescript
import {convertEventsToEvalInvocations} from '@google/adk';

const session = await sessionService.getSession({appName, userId, sessionId});
const invocations = convertEventsToEvalInvocations(session?.events ?? []);
```

Events group by invocation id, in the order the ids were first seen. Within a
group, the user event supplies `userContent` and `creationTimestamp`, the last
gradable agent reply becomes `finalResponse`, and everything else lands in
`intermediateData.invocationEvents`.

Two rules decide the final response and are worth knowing:

- A turn that produced both audio and a text transcript keeps the text, because
  that is what an evaluator can compare. The audio event stays in
  `intermediateData`.
- The final event is not repeated in `intermediateData` unless it carries
  something extra — a tool call, or grounding metadata. A tool call marked with
  `skipSummarization` counts as a final response, and it stays in
  `intermediateData` with its content, so a trajectory metric still sees it.

## Choosing the session

`generateInferencesFromRootAgent` runs in a session it creates through the
supplied `BaseSessionService`, or through a fresh `InMemorySessionService` when
you supply none. `initialSession` names the app and user; without it they are
`EvaluationGenerator` and `test_user_id`.

Pinning `initialSession.sessionId` reuses a session that already exists rather
than replacing it, so you can prepare state and history and evaluate against
them. `initialSession.state` then applies only when the session is created.

## Loading the agent from a module

`generateInferencesFromAgentModule` imports a module and evaluates the agent it
exposes. The module must export an `agent` member holding either an `App` or a
`rootAgent`. An `App` is preferred: its plugins and configuration take part in
the eval run, merged with the plugins the eval system installs. Your `App` is
never modified — the runner is built from a copy.

```typescript
import {generateInferencesFromAgentModule} from '@google/adk';

const invocations = await generateInferencesFromAgentModule({
  modulePath: '/path/to/my_agent.js',
  userSimulator,
  agentName: 'billing_sub_agent', // optional: evaluate a descendant
});
```

The module may also export `agent.resetData`, a function the generator calls
once before the run to clear agent-owned state.

## Failure modes

- A module exposing neither `app` nor `rootAgent` raises an
  `InputValidationError`, as does a `resetData` that is not a function.
- An `agentName` that names no descendant of the root raises a `NotFoundError`.
  A workflow root holds no named sub-agents, so any `agentName` fails there.
- A simulator that returns `SUCCESS` without a message, or a message without
  `SUCCESS`, raises an `Error`. `validateNextUserMessage` performs this check
  and is exported, so a simulator can apply it to itself.
