# Conversation scenarios

A `ConversationScenario` describes a conversation the user simulator plays out
instead of a recorded script: a fixed first message, a plan, and the persona
the simulated user adopts. Reach for it when you want an eval case to state a
goal rather than every user turn.

## Introduction

A recorded eval case pins every user turn, so it only ever tests the path those
turns take. A scenario states the goal instead and lets the simulator find its
own way there, which is how you cover a flow whose turns you cannot write down
in advance.

The persona is the part worth understanding. It carries the behaviors the
simulated user follows — how it advances, which questions it answers, whether
it corrects the agent, how it ends the conversation, and what tone it uses.
Writing one out is long, so the module ships three built-in personas that a
scenario names by id: `EXPERT`, `NOVICE` and `EVALUATOR`.
`parseConversationScenario` resolves the id, and the parsed scenario always
holds a whole `UserPersona`. An id that no persona answers to raises
`NotFoundError` at parse time rather than yielding a scenario with no persona.

`ConversationGenerationConfig` is the other half: it describes how many
scenarios to generate, with what goal, against what environment, and with which
model. Nothing in adk-js consumes it yet; adk-python passes it to Vertex AI's
scenario generation service.

## Get started

Parse a scenarios document that names a built-in persona by id.

```typescript
import {parseConversationScenarios} from '@google/adk';

const document = {
  scenarios: [
    {
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX for next Tuesday, then rent a car.',
      userPersona: 'EXPERT',
    },
  ],
};

const scenarios = parseConversationScenarios(document);
const persona = scenarios.scenarios[0].userPersona;

console.log(persona?.id); // 'EXPERT'
console.log(persona?.behaviors.length); // 6
```

Both key spellings are accepted, so a document written by adk-python parses
unchanged: `starting_prompt`, `conversation_plan` and `user_persona` populate
the same properties. `userPersona` may also be omitted or `null`, and the
parsed scenario then holds `undefined`.

## Naming a persona

`getDefaultPersonaRegistry()` returns a registry holding the three built-in
personas. Each call builds a new registry, so registering over `EXPERT` in one
does not change what the next caller gets.

```typescript
import {getDefaultPersonaRegistry} from '@google/adk';

const registry = getDefaultPersonaRegistry();
const novice = registry.getPersona('NOVICE');

console.log(novice.description);
```

An unknown id is an error, not a silent `undefined`:

```typescript
import {NotFoundError, parseConversationScenario} from '@google/adk';

try {
  parseConversationScenario({
    startingPrompt: 'hi',
    conversationPlan: 'chat',
    userPersona: 'NO_SUCH_PERSONA',
  });
} catch (error: unknown) {
  if (error instanceof NotFoundError) {
    console.log(error.message); // 'NO_SUCH_PERSONA not found in registry.'
  }
}
```

## Writing your own persona

Give the whole persona instead of an id. A persona is a description plus a list
of behaviors; `PRE_BUILT_BEHAVIORS` holds the eleven the built-in personas are
composed from, so you can mix them with your own.

```typescript
import {
  PRE_BUILT_BEHAVIORS,
  UserPersonaRegistry,
  type UserPersona,
} from '@google/adk';

const terse: UserPersona = {
  id: 'TERSE',
  description: 'Answers in as few words as possible.',
  behaviors: [
    PRE_BUILT_BEHAVIORS.ANSWER_RELEVANT_ONLY,
    {
      name: 'Be terse',
      description: 'Keeps every reply short.',
      behaviorInstructions: ['Reply with at most five words.'],
      violationRubrics: ['The reply rambles.'],
    },
  ],
};

const registry = new UserPersonaRegistry();
registry.registerPersona(terse.id, terse);
```

`registerPersona` replaces any persona already under that id.

A behavior's two string lists are prompt text. `behaviorInstructionsText` and
`violationRubricsText` render them the way the simulator's prompt and the
verifier's rubrics show them — one line per entry, each prefixed with ` *`.

```typescript
import {behaviorInstructionsText, PRE_BUILT_BEHAVIORS} from '@google/adk';

console.log(behaviorInstructionsText(PRE_BUILT_BEHAVIORS.CORRECT_AGENT));
// '  * Challenge illogical or incorrect statements made by the Agent.
//   * If the Agent did an incorrect operation, ask the Agent to fix it.'
```

## Validation failures

`parseConversationScenario`, `parseConversationScenarios` and
`parseConversationGenerationConfig` throw `InputValidationError` when the
document is malformed, naming the property at fault. A misspelled key is
rejected rather than dropped, so `userPersonaa` fails instead of silently
producing a scenario with no persona. The one exception is an unknown persona
id, which raises `NotFoundError` as shown above.
