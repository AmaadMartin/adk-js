# Conversation scenarios

A conversation scenario describes a conversation a simulated user should have
with the agent under test: the first thing the user says, the plan the user
follows, and the persona the user adopts. Reach for it when you want an eval
case driven by a goal rather than by a recorded script.

## Introduction

An eval case can carry a recorded conversation, in which case every user turn
is already written down. A scenario is the other option: it states the goal and
lets a user simulator produce the turns. That makes one scenario cover a family
of conversations, and it lets the same goal be replayed against an agent that
answers differently each run.

A scenario document is written by hand or by a generator, so it arrives as
untrusted JSON. `conversationScenariosModel.parse` validates it and returns a value
you can read without further checks. It accepts both key spellings: the
camelCase names adk-js uses, and the snake_case names adk-python writes, so a
document crosses between the two SDKs unchanged.

The `userPersona` field is the part worth knowing about. A scenario may spell a
persona out, or it may name one of the three pre-built personas. The parser
resolves a name through the default persona registry, so a parsed scenario
always holds the persona itself. A name the registry does not know is a
`NotFoundError`, not a dropped field.

## Get started

```typescript
import {conversationScenariosModel} from '@google/adk';

const document = {
  scenarios: [
    {
      startingPrompt: 'I need to book a flight.',
      conversationPlan:
        'Book a one-way flight from SFO to LAX for next Tuesday, ' +
        'then rent a car for three days.',
      userPersona: 'EXPERT',
    },
  ],
};

const scenarios = conversationScenariosModel.parse(document);
const scenario = scenarios.scenarios[0];

scenario.userPersona?.id; // 'EXPERT'
scenario.userPersona?.behaviors.length; // 6
```

`conversationScenariosModel.parse({})` gives `{scenarios: []}`, so an empty
document is valid.

## The default personas

`getDefaultPersonaRegistry()` returns a registry holding three personas, each
composed from the behaviors in `PRE_BUILT_BEHAVIORS`.

| Id          | The user it plays                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `EXPERT`    | Knows what they want and states every detail up front. Corrects the agent, and troubleshoots one failure before giving up.                 |
| `NOVICE`    | States a goal and waits to be asked for the details. Answers every question, and ends the conversation at the first agent failure.         |
| `EVALUATOR` | Checks whether the agent can reach the goals in the plan. States every detail, does not correct the agent, and stops at the first failure. |

Each call returns a new registry, so registering your own persona changes only
your copy.

```typescript
import {getDefaultPersonaRegistry} from '@google/adk';

const registry = getDefaultPersonaRegistry();
registry.registerPersona('IMPATIENT', {
  id: 'IMPATIENT',
  description: 'Gives up after one unhelpful answer.',
  behaviors: [],
});

registry.getPersona('IMPATIENT').id; // 'IMPATIENT'
```

A scenario's `userPersona` string is resolved against the default registry, not
against a registry you built. Spell the persona out in the document to use one
of your own.

## Failure modes

Every parser throws rather than returning a partial value.

| What is wrong                               | What you get                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| A required field is missing                 | `InputValidationError` naming the field                                         |
| A key is misspelled                         | `InputValidationError` naming the key, with the scenario index for a nested one |
| A persona id is not in the default registry | `NotFoundError` reading `<id> not found in registry.`                           |

```typescript
import {conversationScenarioModel} from '@google/adk';

conversationScenarioModel.parse({
  startingPrompt: 'hi',
  conversationPlan: 'chat',
  userPersona: 'NO_SUCH_PERSONA',
});
// throws NotFoundError: NO_SUCH_PERSONA not found in registry.
```

Use `conversationScenariosModel.schema.safeParse(document)` when you would
rather inspect a result than catch an error.

## Rendering a document

A parsed value already holds the camelCase names, so writing it needs nothing
more than `JSON.stringify`. `conversationScenariosModel.dumpByAlias(value)`
writes the snake_case names adk-python reads instead. Both spellings parse back
to the same value, and a resolved persona is written out in full rather than
collapsed back to its id.

```typescript
import {conversationScenariosModel} from '@google/adk';

const scenarios = conversationScenariosModel.parse({
  scenarios: [{startingPrompt: 'hi', conversationPlan: 'chat'}],
});

conversationScenariosModel.dumpByAlias(scenarios);
// {scenarios: [{starting_prompt: 'hi', conversation_plan: 'chat'}]}
```

## Generating scenarios

`ConversationGenerationConfig` is the configuration a scenario generator reads:
how many scenarios to produce (`count`), which Gemini model to use
(`modelName`), and two optional strings that steer the result —
`generationInstruction` for what the scenarios should cover, and
`environmentContext` for the backend data the agent's tools can reach. adk-js
carries the config so a document written for adk-python's generator parses
here; it does not ship the generator itself.

```typescript
import {conversationGenerationConfigModel} from '@google/adk';

conversationGenerationConfigModel.parse({
  count: 5,
  model_name: 'gemini-2.5-flash',
  generation_instruction: 'Cover the refund flow.',
});
// {count: 5, modelName: 'gemini-2.5-flash',
//  generationInstruction: 'Cover the refund flow.'}
```
