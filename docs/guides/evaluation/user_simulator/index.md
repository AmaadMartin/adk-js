# Choosing the user simulator

`UserSimulatorProvider` picks the `UserSimulator` that plays the user for one
eval case. Reach for it when you run an eval set and do not want to choose a
simulator case by case yourself.

## Introduction

An eval case is driven turn by turn. Something must decide what the user says
next and when the conversation ends, and that something is a `UserSimulator`.

A case carries exactly one of two things. A `conversation` is a script: every
user turn is already written, so the provider returns a `StaticUserSimulator`
that replays it. A `conversationScenario` is a goal instead of a script, so the
user's turns are produced while the eval runs. The provider cannot invent that
simulator, so it looks one up.

The lookup key is the `type` discriminator on the config you give the provider.
`registerUserSimulator` writes the entry, and `provide` reads it. This is the
whole extension point: a simulator ships its own config shape with a `type` of
its own, registers itself once at import time, and the provider dispatches to
it with no change to ADK.

ADK registers no simulator of its own yet, so a scenario case is rejected until
you register one. A static case never consults the registry and works with no
config at all.

## Get started

Replay a case's own script. No config and no registration are needed.

```typescript
import {EvalCase, UserSimulatorProvider} from '@google/adk';

const evalCase: EvalCase = {
  evalId: 'two_turns',
  creationTimestamp: 0,
  conversation: [
    {userContent: {role: 'user', parts: [{text: 'what is the weather?'}]}},
    {userContent: {role: 'user', parts: [{text: 'and the temperature?'}]}},
  ],
};

const simulator = new UserSimulatorProvider().provide(evalCase);

const first = await simulator.getNextUserMessage([]);
// first.status === UserSimulatorStatus.SUCCESS
// first.userMessage is the first scripted turn.
```

Call `provide` once per run of a case: a simulator is stateful across the turns
it drives, so a reused one carries on from where the last run stopped.

## Registering a simulator

A scenario case needs a simulator that answers to the config's `type`. Register
a factory for that discriminator, then give the provider a config carrying it.

```typescript
import {
  EvalCase,
  Event,
  NextUserMessage,
  UserSimulatorProvider,
  UserSimulatorStatus,
  registerUserSimulator,
} from '@google/adk';

/** Repeats the scenario's opening question until its turn budget runs out. */
class OpeningSimulator {
  private turns = 0;

  constructor(
    private readonly opening: string,
    private readonly maxTurns: number,
  ) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    if (this.turns >= this.maxTurns) {
      return {status: UserSimulatorStatus.TURN_LIMIT_REACHED};
    }
    this.turns++;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text: this.opening}]},
    };
  }
}

registerUserSimulator(
  'opening',
  ({conversationScenario}) =>
    new OpeningSimulator(conversationScenario.startingPrompt, 1),
);

const scenarioCase: EvalCase = {
  evalId: 'weather_goal',
  creationTimestamp: 0,
  conversationScenario: {
    startingPrompt: 'what is the weather?',
    conversationPlan: 'Ask for the weather, then stop.',
  },
};

const provider = new UserSimulatorProvider({type: 'opening'});
const simulator = provider.provide(scenarioCase);
```

The factory receives the config and the case's scenario. Registering the same
discriminator twice keeps the later factory, so a test can swap an
implementation in without unregistering first.

## Validating your own config

A config read from a JSON eval config document is unchecked. Give your
simulator its own model and validate the config in the factory, so a bad
document fails where it is read rather than mid-conversation.

```typescript
import {
  BaseUserSimulatorConfig,
  EvalModel,
  evalModel,
  optionalField,
  registerUserSimulator,
  unpackUserSimulatorConfig,
} from '@google/adk';
import {z} from 'zod';

interface OpeningConfig extends BaseUserSimulatorConfig {
  type: 'opening';
  maxAllowedInvocations?: number;
}

const openingConfigModel: EvalModel<OpeningConfig> = evalModel(
  {
    type: z.literal('opening'),
    maxAllowedInvocations: optionalField(z.number()),
  },
  {name: 'OpeningConfig', extraKeys: 'allow'},
);

registerUserSimulator('opening', ({config, conversationScenario}) => {
  const {maxAllowedInvocations} = unpackUserSimulatorConfig(
    config,
    openingConfigModel,
  );
  return new OpeningSimulator(
    conversationScenario.startingPrompt,
    maxAllowedInvocations ?? 1,
  );
});
```

`unpackUserSimulatorConfig` accepts both spellings of a field name, so a
document written by ADK Python with `max_allowed_invocations` reads back as
`maxAllowedInvocations`. It keeps the keys your shape does not name. When the
config does not fit, it throws `InputValidationError` reading ``Expect config
of type `OpeningConfig`.``, with the schema error as the `cause`.

## Failure modes

Every rejection is an `InputValidationError`.

- A case carrying neither a `conversation` nor a `conversationScenario`:
  `Neither static invocations nor conversation scenario provided in EvalCase.
Provide exactly one.`
- A case carrying both: `Both static invocations and conversation scenario
provided in EvalCase. Provide exactly one.`
- A scenario case whose config names no registered simulator: ``No
UserSimulator registered for config type `<type>`. Register one via
`registerUserSimulator()`. Currently registered: [...].`` A config with no
  `type` is reported as `BaseUserSimulatorConfig`, because a bare base config
  dispatches to nothing.
- A constructor argument that is not a config object: ``Expect config of type
`BaseUserSimulatorConfig`.``

## Scoring the simulation

`getSimulationEvaluator()` is optional on `UserSimulator`. A simulator that can
judge whether the simulation itself went as intended returns an `Evaluator`
from it, so an eval run can score the simulated user alongside the agent. Call
it as `simulator.getSimulationEvaluator?.()`. `StaticUserSimulator` returns
`undefined`: a replayed script cannot fail to play the user.
