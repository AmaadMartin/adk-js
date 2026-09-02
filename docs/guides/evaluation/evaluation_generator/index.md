# EvaluationGenerator

The evaluation generator runs an agent and records what it did as gradable
`Invocation`s. Reach for it when you have an agent and need the inputs an
evaluator scores, rather than a score.

## Introduction

An evaluator such as `ResponseEvaluator` or `TrajectoryEvaluator` grades
`Invocation` objects. Something has to produce them first. That is this module:
it is the inference half of the eval pipeline, and the evaluators are the
scoring half.

An `Invocation` is one turn. It holds the user message, the agent's final
answer, and the intermediate events of the turn: tool calls, tool responses,
sub-agent replies and grounded answers. A run also records what each agent was
shown. Autorater metrics grade against the instructions and the tool
declarations the model actually saw, so `RequestIntercepterPlugin` captures
each model request and the run reads it back as `AppDetails`.

There are three ways in, and they differ in where the conversation comes from.

- `generateInferencesFromRootAgent` takes an agent object and a
  `UserSimulator`. The simulator supplies one turn at a time and decides when
  the conversation ends.
- `generateInferencesFromAgentModule` loads the agent from a module path first,
  then does the same. Use it when the agent lives on disk.
- `generateResponses` runs every case of an `EvalSet`, several times each.
  A model answers the same prompt differently on each run, so repeating a case
  gives the metrics several samples to average over.

`generateResponsesFromSession` is the exception: it runs no agent at all. It
annotates rows of an eval dataset from a `Session` that was already recorded.

## Get started

Drive an agent through a simulated conversation. The simulator below is a fixed
script; a real one would generate turns from a scenario.

```ts
import {
  Event,
  generateInferencesFromRootAgent,
  LlmAgent,
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
} from '@google/adk';

class ScriptedUserSimulator implements UserSimulator {
  private turn = 0;

  constructor(private readonly messages: string[]) {}

  async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    if (this.turn >= this.messages.length) {
      return {status: UserSimulatorStatus.NO_MESSAGE_GENERATED};
    }
    const text = this.messages[this.turn++];
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text}]},
    };
  }
}

const invocations = await generateInferencesFromRootAgent({
  rootAgent: new LlmAgent({name: 'billing_agent', model: 'gemini-2.0-flash'}),
  userSimulator: new ScriptedUserSimulator(['hello', 'what is my balance?']),
});

invocations.length; // 2, one per turn
invocations[0].finalResponse; // the agent's answer to 'hello'
```

The `Invocation[]` this returns is what an evaluator scores.

## The simulator contract

`getNextUserMessage` returns a message and a status, and the two must agree: a
`userMessage` is present if and only if the status is `SUCCESS`. The run checks
this with `validateNextUserMessage` on every turn and throws when they
disagree. Any other status ends the conversation.

A simulator is stateful across the turns it drives, so create one per run.
`generateResponses` does this for you: it calls the `createUserSimulator`
factory once per repeat, not once per case.

The simulator receives a deep copy of the events so far. It cannot disturb the
transcript the run records.

## Sessions and services

A run creates in-memory session, artifact and memory services unless you pass
your own. It also creates the session, under the app name
`EvaluationGenerator` and the user `test_user_id` by default.

`initialSession` overrides those and can pin a session id. A pinned id is
looked up first and reused when it exists, so a session you prepared keeps its
state and its events, and a second run under the same id does not collide.
`initialSession.state` therefore applies only when the session has to be
created.

Passing an `app` runs the agent with the app's own plugins and configuration.
The run never mutates your `App`: it builds a copy whose root is the agent
under evaluation, with the eval plugins appended after the app's own.

## Annotating a recorded session

`generateResponsesFromSession` reads a `Session` from a JSON file and fills in
what the agent did, without running anything. Each row it returns is a copy
carrying two added keys, `actual_tool_use` and `response`.

```ts
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
writes and reads. A row whose `query` is not a string raises
`InputValidationError`, and a query the session never saw yields an empty
`actual_tool_use` and an undefined `response`.
