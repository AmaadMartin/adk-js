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

There are several ways in. `generateInferencesFromRootAgent` runs the agent
now: a `UserSimulator` supplies each user turn and decides when the
conversation ends, so a multi-turn eval case needs no recorded script.
`generateInferencesFromAgentModule` loads the agent from a module path first,
then does the same. `generateResponses` runs every case of an `EvalSet`,
several times each. `convertEventsToEvalInvocations` works from events you
already have, so a session recorded in production can be graded without running
anything, and `generateResponsesFromSession` annotates eval rows from a
recorded session file.

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
it cannot disturb the record the generator keeps. A simulator is stateful
across the turns it drives, so create one per run.

## Running a whole eval set

`generateResponses` runs every case of an `EvalSet`. A model answers the same
prompt differently on each run, so it repeats each case — three times by
default — and returns one `EvalCaseResponses` per case, holding the invocations
of every repeat. It calls the `createUserSimulator` factory once per repeat,
because a simulator cannot be reused.

```typescript
import {generateResponses} from '@google/adk';

const perCase = await generateResponses({
  evalSet,
  agentModulePath: '/path/to/my_agent.js',
  repeatNum: 5,
  createUserSimulator: (evalCase) => new ScriptedUserSimulator(turns(evalCase)),
});

// perCase[0].responses[2] -> the invocations of the third run of the first case
```

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

The artifact and memory services work the same way: the run uses the ones you
pass, and creates in-memory ones otherwise.

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

## Annotating an eval dataset

`generateResponsesFromSession` reads a `Session` from a JSON file and fills in
what the agent did, without running anything. Each row it returns is a copy
carrying two added keys, `actual_tool_use` and `response`.

```typescript
import {generateResponsesFromSession} from '@google/adk';

const dataset = [[{query: 'roll a die'}]];
const annotated = await generateResponsesFromSession(
  '/tmp/session.json',
  dataset,
);

annotated[0][0]['actual_tool_use']; // [{tool_name: 'roll_die', tool_input: {sides: 6}}]
annotated[0][0]['response']; // the agent's final text
```

The keys stay snake_case because they are the eval-data format adk-python
writes and reads. A query the session never saw yields an empty
`actual_tool_use` and an undefined `response`.

## Live mode

`generateInferencesFromRootAgentLive` is the live counterpart of
`generateInferencesFromRootAgent`. It returns the same `Invocation[]`, so the
same evaluators grade it.

```typescript
import {generateInferencesFromRootAgentLive} from '@google/adk';

const invocations = await generateInferencesFromRootAgentLive({
  rootAgent: liveAgent,
  userSimulator: new ScriptedUserSimulator(['what colour is the sky?']),
  liveTimeoutSeconds: 600,
});
```

A live run is push-shaped: the model streams events whenever it likes. The eval
loop is pull-shaped and asks for one turn at a time. The function bridges the
two: it consumes the event stream on a background task and waits for a per-turn
latch the model releases when it reports the turn complete.

### The run config

Every live driver runs under `LIVE_RUN_CONFIG`: audio response modality, input
and output transcription, and server-side voice-activity detection turned off.
Turn boundaries therefore come from the activity markers the harness sends
around each audio turn, not from the model's own silence detection.

### Audio and transcription

A user turn carrying `inlineData` is streamed as realtime audio by
`sendAudioToLive`, in 16000-byte chunks bracketed by one activity start and one
activity end. The turn's full content, text included, is still recorded as the
user event, so an autorater sees what the user said even though the model only
heard it.

A native-audio model answers in audio and reports its words separately, as a
transcription on an event that carries no content. `normalizeLiveTranscriptions`
folds those into text content, both before the history reaches the user
simulator and before the invocations are built.

### Tool calls

When the model calls a tool mid-turn, the driver runs it and sends each
`functionResponse` back into the live request queue with `role: 'tool'`. If the
tool loop throws, every call still gets an answer — one `functionResponse`
carrying `{error: <message>}` — so the model is not left waiting on a response
that never arrives.

The `turnComplete` that accompanies a tool call is not the end of the turn, so
the driver swallows it and honours the next one. Calls that hand off instead of
continuing — `finish_task`, `transfer_to_agent`, `task_completed` — are the
exception: they end the agent, so the `turnComplete` after them is real.

### Timeouts and closure

A turn the model never completes fails after `liveTimeoutSeconds`, which
defaults to 300 seconds. The live session is closed either way.

Closing the session closes the request queue and waits up to 30 seconds for the
background consumer. After that it warns, aborts the run, and returns. An
aborted consumer stops at its next event, so it does not keep writing to the
session after the call returned. A WebSocket close code of 1000 is a normal end
of stream: the transcript collected so far is kept and the eval case is not
failed. Any other close code propagates.

### Workflow roots are not supported

`generateInferencesFromRootAgentLive` needs an agent root. It rejects a
`Workflow` with an `InputValidationError` before it opens a live session,
because `Runner.runLive` does not accept a non-agent root. Evaluate a workflow
with `generateInferencesFromRootAgent`, which does support one.

## Failure modes

- A module exposing neither `app` nor `rootAgent` raises an
  `InputValidationError`, as does a `resetData` that is not a function.
- An `agentName` that names no descendant of the root raises a `NotFoundError`.
  A workflow root holds no named sub-agents, so any `agentName` fails there.
- A simulator that returns `SUCCESS` without a message, or a message without
  `SUCCESS`, raises an `Error`. `validateNextUserMessage` performs this check
  and is exported, so a simulator can apply it to itself.
- A dataset row whose `query` is not a string raises an
  `InputValidationError`.
- A `Workflow` root passed to `generateInferencesFromRootAgentLive` raises an
  `InputValidationError`. The live path needs an agent root.
