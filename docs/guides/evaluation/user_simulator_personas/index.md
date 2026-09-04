# User simulator personas

A `UserPersona` says how a simulated user behaves during an eval conversation.
`UserPersonaRegistry` holds the personas one eval run can use, each under the
id an eval case names. Reach for them when several eval cases share one way of
behaving, so you write the behavior once and name it from many cases.

## Introduction

An eval case that drives a simulated user needs two things: what the user
wants, and how the user acts while pursuing it. The scenario carries the goal.
The persona carries the manner — a terse user, a user who changes their mind, a
user who gives one detail per turn.

A persona is a `UserPersona` with an `id`, a `description` and a list of
`UserBehavior`. Each behavior names one habit and holds two lists.
`behaviorInstructions` tells the simulator what to do. `violationRubrics` tells
the simulator's evaluator what a broken habit looks like. Both lists reach a
model as prompt text, so `getBehaviorInstructionsStr` and
`getViolationRubricsStr` render a list as indented bullets.

`UserPersonaRegistry` is an in-process map from id to persona. It does no I/O
and there is no global instance, so a harness builds its own registry,
registers the personas its suite needs, and looks each one up by id.
Registration overwrites: a second call on the same id replaces the persona and
writes a debug line.

## Get started

```typescript
import {
  getBehaviorInstructionsStr,
  getViolationRubricsStr,
  UserPersonaRegistry,
  type UserPersona,
} from '@google/adk';

const terseUser: UserPersona = {
  id: 'terse_user',
  description: 'A user who answers in as few words as possible.',
  behaviors: [
    {
      name: 'brevity',
      description: 'Keeps every reply short.',
      behaviorInstructions: [
        'Reply with at most five words.',
        'Never explain your reasoning.',
      ],
      violationRubrics: [
        'The reply runs longer than five words.',
        'The reply explains the reasoning behind the answer.',
      ],
    },
  ],
};

const registry = new UserPersonaRegistry();
registry.registerPersona(terseUser.id, terseUser);

const behavior = registry.getPersona('terse_user').behaviors[0];

getBehaviorInstructionsStr(behavior);
// '  * Reply with at most five words.\n  * Never explain your reasoning.'
getViolationRubricsStr(behavior);
// '  * The reply runs longer than five words.\n  * The reply explains the reasoning behind the answer.'
```

## Looking a persona up

`getPersona` returns the registered persona by reference. It throws
`NotFoundError` when nothing is registered under that id, and the message names
the id, so a typo in an eval case fails where the id is read:

```typescript
import {NotFoundError, UserPersonaRegistry} from '@google/adk';

const registry = new UserPersonaRegistry();

try {
  registry.getPersona('tense_user');
} catch (error) {
  if (error instanceof NotFoundError) {
    // error.message is 'tense_user not found in registry.'
  }
}
```

## Registration rules

- The registry never rejects an id, an empty id included. `registerPersona` on
  an id already there replaces the persona, keeps its position in the list, and
  logs the id at debug level.
- The registration id is the lookup key. It does not have to equal
  `userPersona.id`, so one persona can be registered under several ids.
- `getRegisteredPersonas` returns a fresh array in registration order. Changing
  that array does not change the registry, and the personas in it are the
  registered objects, not copies.

## Formatting

Both formatters render one entry per line as `  * <entry>`: two spaces, an
asterisk, a space, the entry. There is no trailing newline, and an empty list
gives an empty string. An entry that itself contains a newline is spliced in
unchanged, so its second line carries no bullet and no indent. Keep each entry
on one line when the prompt needs every line to be a bullet.

The output matches adk-python's `get_behavior_instructions_str` and
`get_violation_rubrics_str` byte for byte, so both software development kits
send the same prompt text to the same judge model.
