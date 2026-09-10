# Pre-built user personas

`getDefaultPersonaRegistry()` hands back the user personas ADK ships, and
`PRE_BUILT_BEHAVIORS` holds the atomic behaviors they are built from. Reach for
them when a scenario-driven eval needs a simulated user, and you do not want to
write the instruction and rubric text yourself.

## Introduction

A conversation scenario says what the user wants, not how the user acts. The
persona supplies the second half. It tells the user simulator how to advance
through the plan, which agent questions to answer, whether to correct a mistake,
when to stop, and in what tone. The same text also feeds the evaluator that
grades each simulated turn, so the persona decides both what the user does and
what counts as a valid user turn.

Writing that text by hand is the tedious part. A persona is a list of
`UserBehavior` values, and each behavior carries a `description`, a list of
`behaviorInstructions` and a list of `violationRubrics` — all of them prose that
goes straight into a model prompt. `PRE_BUILT_BEHAVIORS` is the eleven-entry
catalogue of that prose, shared with adk-python, and the three shipped personas
are compositions of it.

A `UserPersonaRegistry` maps an id to a persona. `getDefaultPersonaRegistry()`
builds one holding `EXPERT`, `NOVICE` and `EVALUATOR`.

## Get started

Pick a shipped persona by id and put it in a conversation scenario.

```typescript
import {getDefaultPersonaRegistry} from '@google/adk';

const userPersona = getDefaultPersonaRegistry().getPersona('EXPERT');

const scenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book SFO to LAX next Tuesday, morning, under $150.',
  userPersona,
};
```

`getPersona` throws `NotFoundError` for an id the registry does not hold. The
message is `` `${personaId} not found in registry.` ``.

## The shipped personas

| Id          | What it does                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPERT`    | States a goal with every detail attached, answers only relevant questions, corrects the agent, troubleshoots once, and keeps a professional tone.                          |
| `NOVICE`    | States a bare goal and waits to be asked for details, answers every question, never corrects the agent, stops at the first agent failure, and keeps a conversational tone. |
| `EVALUATOR` | Advances like an expert but does not correct the agent and stops at the first failure. Use it to ask whether the agent can carry the plan on its own.                      |

Read the behaviors of one to see the exact prompt text:

```typescript
import {
  getBehaviorInstructionsStr,
  getDefaultPersonaRegistry,
} from '@google/adk';

const novice = getDefaultPersonaRegistry().getPersona('NOVICE');
for (const behavior of novice.behaviors) {
  const instructions = getBehaviorInstructionsStr(behavior);
  // `instructions` is one indented bullet per instruction, or '' for none.
}
```

`getBehaviorInstructionsStr` and `getViolationRubricsStr` render a behavior's
lists as prompt bullets: two spaces, an asterisk, a space, then the entry, one
per line. An empty list renders `''`.

## Composing your own persona

A persona is a plain object, so mix one out of the catalogue and register it
under an id of your own.

```typescript
import {PRE_BUILT_BEHAVIORS, getDefaultPersonaRegistry} from '@google/adk';

const registry = getDefaultPersonaRegistry();
registry.registerPersona('IMPATIENT', {
  id: 'IMPATIENT',
  description: 'Wants the task done in as few turns as possible.',
  behaviors: [
    PRE_BUILT_BEHAVIORS.ADVANCE_DETAIL_ORIENTED,
    PRE_BUILT_BEHAVIORS.END_NO_TROUBLESHOOTING,
    PRE_BUILT_BEHAVIORS.TONE_PROFESSIONAL,
  ],
});

const impatient = registry.getPersona('IMPATIENT');
```

The first argument to `registerPersona` is the lookup key. It does not have to
equal the persona's own `id`, so one persona can answer to several ids.
Registering an id twice replaces the persona and logs the id at debug level.

Nothing stops you from writing a behavior from scratch either: `UserBehavior` is
an interface, so any object with the four fields works.

## Two properties worth knowing

**Each call builds a new registry.** `getDefaultPersonaRegistry()` returns a
fresh `UserPersonaRegistry` every time. Registering `IMPATIENT` above changes
only that registry; a later call hands back one holding the three shipped
personas again. This is what keeps one eval run from corrupting another.

**The catalogue is frozen shallowly.** `PRE_BUILT_BEHAVIORS` is an
`Object.freeze`d record, so you cannot replace an entry. The arrays inside a
behavior are not frozen, and pushing to one changes the text every persona that
uses that behavior sends to the model. Copy a behavior before you edit it.
