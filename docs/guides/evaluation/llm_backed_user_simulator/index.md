# LlmBackedUserSimulator

`LlmBackedUserSimulator` plays the user side of an eval case with a model. You
give it a goal instead of a script, and it writes each user turn from the
conversation so far. Reach for it when the turns you want depend on what the
agent says, so you cannot write them in advance.

## Introduction

An eval case is driven turn by turn, and a `UserSimulator` decides what the
user says next. A case that carries a pre-authored conversation already knows
every user turn, so replaying that script is all it needs. A script cannot
answer a question the agent asks, because every reply was fixed before the
run.

`LlmBackedUserSimulator` reads a `ConversationScenario` instead. The scenario
carries a `startingPrompt`, which is the fixed opening message, and a
`conversationPlan`, which is the goal the simulated user pursues. Every later
turn is written by a model that sees the plan and the dialogue so far, so the
simulated user can answer the agent, correct it, and stop once the plan is
done. An optional `userPersona` gives that user a manner.

The simulator holds the turn count and the scenario, so build one per eval
case and per repeat.

## Get started

```typescript
import {
  LlmBackedUserSimulator,
  UserSimulatorStatus,
  type Event,
} from '@google/adk';
import {type Content} from '@google/genai';

/** Sends one user turn to your agent and returns the events it produced. */
declare function runAgentTurn(userMessage: Content): Promise<Event[]>;

async function simulateConversation(): Promise<Event[]> {
  const simulator = new LlmBackedUserSimulator({
    config: {model: 'gemini-2.5-flash', maxAllowedInvocations: 20},
    conversationScenario: {
      startingPrompt: 'I need to book a flight.',
      conversationPlan:
        'Book a one-way flight from SFO to LAX for next Tuesday. You prefer' +
        ' a morning flight and your budget is under $150. Confirm the' +
        ' booking once the agent finds a valid flight.',
    },
  });

  const events: Event[] = [];
  // The first call returns the starting prompt and asks no model. Every later
  // call reads `events` and asks the model for the next user turn.
  let next = await simulator.getNextUserMessage(events);
  while (next.status === UserSimulatorStatus.SUCCESS && next.userMessage) {
    events.push(...(await runAgentTurn(next.userMessage)));
    next = await simulator.getNextUserMessage(events);
  }
  return events;
}
```

The simulator resolves `config.model` through `LLMRegistry`, so a Gemini model
needs the credentials that model needs. Pass `llm` to use a model you built
yourself:

```typescript
import {LlmBackedUserSimulator, type BaseLlm} from '@google/adk';

function simulatorOver(myModel: BaseLlm): LlmBackedUserSimulator {
  return new LlmBackedUserSimulator({
    config: {model: myModel.model},
    conversationScenario: {
      startingPrompt: 'Hello',
      conversationPlan: 'Ask for the weather, then say goodbye.',
    },
    llm: myModel,
  });
}
```

## Reading the result

`getNextUserMessage` returns a `NextUserMessage`, and its `status` says whether
the conversation continues.

| Status                 | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `SUCCESS`              | `userMessage` holds the next user turn.                                  |
| `STOP_SIGNAL_DETECTED` | The model wrote `</finished>`, so the plan is done. There is no message. |
| `TURN_LIMIT_REACHED`   | The invocation limit was hit. There is no message.                       |

A `userMessage` is present if and only if the status is `SUCCESS`.

The simulator throws when the model returns nothing. An empty answer is a
failed run rather than a conversation that ended, so it is an error and not a
status. The message names the cause: `LLM returned empty response`, `LLM
returned only thinking tokens`, or `safety filters or other error (code=...)`.

## Options

Every field of `LlmBackedUserSimulatorConfig` is optional.

| Field                   | Default                        | What it does                                                                             |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `model`                 | `gemini-2.5-flash`             | The model that writes the user's turns.                                                  |
| `modelConfiguration`    | thinking on, a budget of 10240 | The `GenerateContentConfig` of that model.                                               |
| `maxAllowedInvocations` | `20`                           | The turns one conversation may run, the opening prompt included. `-1` removes the limit. |
| `customInstructions`    | none                           | Instructions that replace the built-in prompt.                                           |
| `includeFunctionCalls`  | `false`                        | Whether the history the model reads shows the agent's tool calls and tool results.       |

The limit exists to end a conversation in which the agent and the simulated
user answer each other forever. The opening prompt counts against it, so
`maxAllowedInvocations: 1` allows the opening turn and nothing more.

## Custom instructions

`customInstructions` replaces the built-in prompt. It is a Jinja template, and
it must read three placeholders:

```typescript
import {LlmBackedUserSimulator} from '@google/adk';

const simulator = new LlmBackedUserSimulator({
  config: {
    model: 'gemini-2.5-flash',
    customInstructions:
      'Follow this plan: {{ conversation_plan }}\n' +
      'The conversation so far: {{ conversation_history }}\n' +
      'Write {{ stop_signal }} when the plan is done.',
  },
  conversationScenario: {
    startingPrompt: 'I need to book a flight.',
    conversationPlan: 'Book a morning flight from SFO to LAX.',
  },
});
```

The constructor throws `InputValidationError` when one of the three is
missing. A template combined with a persona must also read `{{ persona }}`, and
`getUserSimulatorInstructionsTemplate` throws `InputValidationError` when it
does not.

## Personas

A `userPersona` on the scenario switches the simulator to a prompt that
describes the persona and its behaviors.

```typescript
import {LlmBackedUserSimulator} from '@google/adk';

const simulator = new LlmBackedUserSimulator({
  config: {model: 'gemini-2.5-flash'},
  conversationScenario: {
    startingPrompt: 'I need to book a flight.',
    conversationPlan: 'Book a morning flight from SFO to LAX.',
    userPersona: {
      id: 'terse_traveller',
      description: 'A frequent traveller in a hurry.',
      behaviors: [
        {
          name: 'terse',
          description: 'Answers in as few words as possible.',
          behaviorInstructions: ['Answer with one short sentence.'],
          violationRubrics: ['Writes more than two sentences.'],
        },
      ],
    },
  },
});
```

A persona field may itself name a placeholder, such as
`Answer as {{ stop_signal }} demands`. adk-js substitutes a plain dotted path
in such a field and renders anything else as empty. It does not compile the
field, because nunjucks is not a sandbox and a persona can come from a data
file. adk-python compiles the field with Jinja's `SandboxedEnvironment`
instead, which raises `SecurityError` for an expression that reaches a
Python internal.

## Differences from adk-python

- `UserSimulator` is an interface here and an abstract class in adk-python, so
  the simulator implements it rather than extending it. There is no
  `BaseUserSimulatorConfig`, hence no `type: 'llm_backed'` discriminator:
  nothing in adk-js routes on one.
- There is no `getSimulationEvaluator`. adk-python declares it and raises
  `NotImplementedError`; the adk-js interface has no such member.
- A persona field is interpolated rather than compiled, as described above.
- `llm` is an addition. adk-python always resolves the model through its
  registry.
- An `EvalCase` cannot carry a `ConversationScenario` yet, so nothing selects
  this simulator for you. Construct it and drive it yourself.
