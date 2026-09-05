# Simulating a user with a model

`LlmBackedUserSimulator` plays the user side of an eval conversation. Reach for
it when the case describes a goal, such as "book a flight and then a car",
instead of a script of user turns.

## Introduction

An eval case is driven turn by turn, and a `UserSimulator` decides what the
user says next. `StaticUserSimulator` replays turns the case already carries,
so it cannot react to what the agent said. That is enough to check a fixed
transcript, and not enough to check whether the agent can reach a goal by some
route the author did not write down.

`LlmBackedUserSimulator` takes a `ConversationScenario` instead: a fixed
starting prompt plus a plan in prose. The first turn is the starting prompt and
costs no model call. Every later turn summarizes the conversation so far and
asks a model what the user says next, until the plan is met, the model emits
the stop signal, or the turn budget runs out.

`UserSimulatorProvider` does not route to this simulator yet, so pass it to
`generateResponses` through `createUserSimulator`, or drive it yourself.

## Get started

```typescript
import {
  ConversationScenario,
  Event,
  LlmBackedUserSimulator,
  UserSimulatorStatus,
} from '@google/adk';

const scenario: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan:
    'Book a one-way flight from SFO to LAX next Tuesday, in the morning, ' +
    'under $150. Confirm the booking, then rent a standard car for three days.',
};

const simulator = new LlmBackedUserSimulator({
  config: {model: 'gemini-2.5-flash', maxAllowedInvocations: 20},
  conversationScenario: scenario,
});

/** Returns the next user turn, or undefined once the conversation is over. */
async function nextUserTurn(events: Event[]): Promise<string | undefined> {
  const next = await simulator.getNextUserMessage(events);
  if (next.status !== UserSimulatorStatus.SUCCESS) {
    return undefined;
  }
  return next.userMessage?.parts?.[0].text;
}
```

Call `nextUserTurn` with the whole conversation so far, send its result to the
agent, and repeat. The first call returns `'I need to book a flight.'` without
calling the model.

## Configuration

Every field has a default.

| Field                   | Default                                  | What it does                                                                           |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `model`                 | `'gemini-2.5-flash'`                     | The model that plays the user.                                                         |
| `modelConfiguration`    | thinking budget 10240, thoughts included | The config the model is called with.                                                   |
| `maxAllowedInvocations` | `20`                                     | Turns the conversation may take, the starting prompt included. `-1` removes the limit. |
| `customInstructions`    | none                                     | Instructions that replace the built-in ones.                                           |
| `includeFunctionCalls`  | `false`                                  | Whether the model sees the agent's tool calls and their results.                       |

`parseLlmBackedUserSimulatorConfig` validates a config document and applies
these defaults. It reads the snake_case spelling adk-python writes as well as
the camelCase one, and throws `InputValidationError` on a document it cannot
accept.

`modelConfiguration` is opaque: it reaches the model exactly as you wrote it,
so its own keys keep their spelling and an `AbortSignal` in it survives. Write
them the way `@google/genai` declares them — `thinkingConfig`, not
`thinking_config`.

## Custom instructions

Custom instructions are text with `{{ placeholder }}` substitutions. They must
reference `{{ stop_signal }}`, `{{ conversation_plan }}` and
`{{ conversation_history }}`; a template that misses one is rejected when the
config is parsed.

A placeholder holds a name, optionally dotted, and nothing else. An expression,
a filter or a `{% ... %}` statement is rejected rather than passed to the
model, so the subset is narrower than adk-python's Jinja. The reason is that
instructions and personas are evaluation data. adk-python renders them in a
Jinja2 `SandboxedEnvironment`; JavaScript's Jinja-compatible engines have no
sandbox, and rendering data through one lets `{{ range.constructor('...')() }}`
execute. Substitution evaluates nothing.

```typescript
const simulator = new LlmBackedUserSimulator({
  config: {
    customInstructions: [
      'You are in a hurry. Follow this plan: {{ conversation_plan }}',
      'The conversation so far: {{ conversation_history }}',
      'Write {{ stop_signal }} once the plan is done.',
    ].join('\n'),
  },
  conversationScenario: scenario,
});
```

## Personas

A scenario may name the persona the simulated user adopts. The built-in
instructions then describe the persona and its behaviors to the model.

```typescript
const scenarioWithPersona: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book a morning flight from SFO to LAX under $150.',
  userPersona: {
    id: 'terse_traveller',
    description: 'A traveller who answers in as few words as possible.',
    behaviors: [
      {
        name: 'terse',
        description: 'gives short answers',
        behaviorInstructions: ['Answer with one sentence.'],
        violationRubrics: ['writes more than one sentence'],
      },
    ],
  },
};
```

A behavior's name, description and instructions carry placeholders of their
own, so a behavior may refer to `{{ stop_signal }}` or
`{{ conversation_plan }}`. The persona's own description is inserted verbatim.

Custom instructions combined with a persona must also reference
`{{ persona }}`. A persona offers `{{ persona.id }}`,
`{{ persona.description }}` and `{{ persona.behaviors }}`, the last being the
rendered behavior list; bare `{{ persona }}` is the description followed by
that list.

## How a conversation ends

`getNextUserMessage` returns a status rather than throwing when the simulation
ends normally.

- `SUCCESS` carries the next user message.
- `STOP_SIGNAL_DETECTED` means the model wrote `</finished>`, in any case. The
  conversation is over and there is no message.
- `TURN_LIMIT_REACHED` means `maxAllowedInvocations` is spent.

A model that answers with nothing is a failure of the model, not an outcome of
the simulation, so it throws instead. The message names the reason: `safety
filters or other error (code=...)` when the model reported an error code, `LLM
returned only thinking tokens` when it produced thoughts and no text, and `LLM
returned empty response` otherwise.
