# Pre-built user personas

`getDefaultPersonaRegistry()` returns the three personas ADK ships for the user
simulator: `EXPERT`, `NOVICE` and `EVALUATOR`. Reach for it when you evaluate an
agent against a kind of user, and you do not want to write the prompt text that
describes that user.

## Introduction

An eval case that states a goal instead of a script needs something to play the
user. That something reads a `UserPersona`: a description of who the user is,
plus the behaviors they follow. The persona text is not documentation. It is
interpolated into the user simulator's instructions, and into the rubrics the
per-turn judge grades each simulated turn against.

Writing a persona by hand means writing eleven blocks of prompt text and then
keeping them stable, because changing the text changes what the simulator does
and what the judge accepts. ADK ships that text so you do not have to. It is
copied verbatim from ADK Python, so the same persona drives the same
conversation in both SDKs.

A persona is composed from behaviors rather than written as one prose block.
`PRE_BUILT_BEHAVIORS` holds the eleven atomic behaviors, grouped by the decision
each one makes:

| Prefix                         | Decides                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `ADVANCE_`                     | how much detail the user volunteers with a new request   |
| `ANSWER_`                      | whether the user answers questions unrelated to the goal |
| `CORRECT_` / `DO_NOT_CORRECT_` | whether the user challenges an agent mistake             |
| `TROUBLESHOOT_`                | whether the user helps the agent recover from a failure  |
| `END_`                         | when the user stops the conversation                     |
| `TONE_`                        | how the user writes                                      |

The three personas differ only in which behaviors they pick:

- `EXPERT` knows what it wants, states every detail up front, corrects the agent
  and troubleshoots once.
- `NOVICE` states only a high-level goal, answers every question, and cannot
  correct or troubleshoot the agent.
- `EVALUATOR` states every detail up front, but ends the conversation on the
  first agent failure instead of troubleshooting it.

## Get started

Ask the registry for a persona by id.

```typescript
import {getDefaultPersonaRegistry} from '@google/adk';

const persona = getDefaultPersonaRegistry().getPersona('NOVICE');

// The five behaviors a novice user follows, in the order the prompt lists them.
const behaviorNames = persona.behaviors.map((behavior) => behavior.name);
```

`getPersona` throws `NotFoundError` for an id nothing is registered under, so a
typo fails at the call instead of producing an agent evaluated against no
persona at all. The message is `` `${personaId} not found in registry.` ``.

## Rendering a behavior into a prompt

A behavior carries two string lists: `behaviorInstructions`, which tells the
simulator what to do, and `violationRubrics`, which tells the judge what counts
as a bad turn. Both render as one bullet per line, two spaces then `* `.

```typescript
import {PRE_BUILT_BEHAVIORS, getBehaviorInstructionsStr} from '@google/adk';

const instructions = getBehaviorInstructionsStr(
  PRE_BUILT_BEHAVIORS.DO_NOT_CORRECT_AGENT,
);
// '  * If the Agent made an illogical or incorrect statement, end the
//  conversation with `{{ stop_signal }}`.'
```

`getViolationRubricsStr` does the same for the rubrics. An empty list renders
as an empty string, which produces an empty prompt section rather than an error.

`{{ stop_signal }}` stays literal here. The user simulator substitutes it when
it builds the prompt.

## Registering your own persona

`getDefaultPersonaRegistry()` builds a new registry on every call, and
`registerPersona` overwrites whatever holds that id. So you can replace a
pre-built persona in your own registry without changing what anyone else
resolves.

```typescript
import {
  PRE_BUILT_BEHAVIORS,
  UserPersona,
  getDefaultPersonaRegistry,
} from '@google/adk';

const terseExpert: UserPersona = {
  id: 'EXPERT',
  description: 'An expert who never explains twice.',
  behaviors: [
    PRE_BUILT_BEHAVIORS.ADVANCE_DETAIL_ORIENTED,
    PRE_BUILT_BEHAVIORS.ANSWER_RELEVANT_ONLY,
    PRE_BUILT_BEHAVIORS.END_NO_TROUBLESHOOTING,
    PRE_BUILT_BEHAVIORS.TONE_PROFESSIONAL,
  ],
};

const registry = getDefaultPersonaRegistry();
registry.registerPersona('EXPERT', terseExpert);

// ['EXPERT', 'NOVICE', 'EVALUATOR'], with 'EXPERT' now resolving to terseExpert.
const registeredIds = registry.getRegisteredPersonas().map((p) => p.id);
```

`getRegisteredPersonas()` returns the personas in registration order, so the
three defaults come first and anything you add follows them.

## What the catalogue guarantees

- `PRE_BUILT_BEHAVIORS` is frozen, so a caller cannot add or replace a catalogue
  entry. The freeze is one level deep. Every registry shares the same behavior
  objects, so editing one behavior's own fields changes the prompt text
  everywhere; treat those fields as read-only.
- The behavior and persona text matches ADK Python field for field, including
  its typographical errors. The text is model input, so correcting a typo would
  change what the simulator produces and what the judge accepts. Write your own
  behavior instead of editing one of these.
- No two behaviors in the catalogue hold the same content, and no pre-built
  persona lists the same behavior twice.
