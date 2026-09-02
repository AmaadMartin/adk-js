# Choosing the user simulator

`UserSimulatorProvider` picks the `UserSimulator` that plays the user for one
eval case. Reach for it when you run an `EvalSet` and do not want to write a
simulator factory yourself.

## Introduction

An eval case is driven turn by turn. Something must decide what the user says
next and when the conversation ends, and that something is a `UserSimulator`.
Two cases need two different answers. A case that ships a pre-authored
`conversation` already knows every user turn, so it only needs those turns
replayed. A case that describes a goal instead needs a model to improvise the
turns.

The provider makes that choice. A case carrying a `conversation` gets a
`StaticUserSimulator` over it, whatever the configuration says: the turns are
already written, so there is nothing to improvise. Any other case is routed by
the `type` field of `BaseUserSimulatorConfig` to the simulator registered under
that name.

The registry is the extension point. A simulator ships its own config type and
calls `registerUserSimulator` once from its own module, so the provider
dispatches to it without knowing it exists. Registering a name twice replaces
the earlier factory.

`generateResponses` uses the provider when the caller passes no
`createUserSimulator`, which is why an eval set of static conversations runs
with no simulator argument at all. A `createUserSimulator` that you do pass
wins over `userSimulatorConfig`.

## Get started

Run an eval set whose cases carry static conversations. No simulator argument
is needed.

```typescript
import {EvalSet, generateResponses} from '@google/adk';

const evalSet: EvalSet = {
  evalSetId: 'weather',
  creationTimestamp: 0,
  evalCases: [
    {
      evalId: 'two_turns',
      creationTimestamp: 0,
      conversation: [
        {userContent: {role: 'user', parts: [{text: 'what is the weather?'}]}},
        {userContent: {role: 'user', parts: [{text: 'and the temperature?'}]}},
      ],
    },
  ],
};

const results = await generateResponses({
  evalSet,
  agentModulePath: './weather_agent.js',
  repeatNum: 1,
});
```

Each entry of `results` holds one `Invocation` per replayed turn.

## Registering a simulator

A simulator claims a `type` name and builds itself from the config and the
eval case it was given.

```typescript
import {
  BaseUserSimulatorConfig,
  Event,
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
  registerUserSimulator,
} from '@google/adk';

/** Asks the eval case's own opening question, then ends the conversation. */
class OneShotSimulator implements UserSimulator {
  private asked = false;

  constructor(private readonly opening: string) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    if (this.asked) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    this.asked = true;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text: this.opening}]},
    };
  }
}

/** Reads an extra field off a config without widening its type. */
function opening(config: BaseUserSimulatorConfig): string {
  return 'opening' in config && typeof config.opening === 'string'
    ? config.opening
    : 'hello';
}

registerUserSimulator(
  'one_shot',
  ({config}) => new OneShotSimulator(opening(config)),
);
```

Pass `userSimulatorConfig: {type: 'one_shot', opening: 'hello'}` to
`generateResponses`, and every case without a static conversation runs on
`OneShotSimulator`.

## Guarantees

- One simulator per repeat. `generateResponses` calls `provide` once for every
  run of every case, because a simulator is stateful across the turns it
  drives.
- A static conversation always replays. The configuration cannot override it.
- `StaticUserSimulator` never throws. Running past the last scripted turn
  returns `STOP_SIGNAL_DETECTED` with no message, which is how the generator
  learns the conversation is over.

## Failure modes

| Condition                                                        | Error                                         |
| ---------------------------------------------------------------- | --------------------------------------------- |
| The case has no `conversation` and the config names no simulator | `InputValidationError`                        |
| The config names a `type` nothing registered                     | `NotFoundError`, listing the registered names |
