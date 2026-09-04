# Choosing the user simulator

`UserSimulatorProvider` picks the `UserSimulator` that plays the user for one
eval case. Reach for it when you run an `EvalSet` and do not want to write a
simulator factory yourself.

## Introduction

An eval case is driven turn by turn. Something must decide what the user says
next and when the conversation ends, and that something is a `UserSimulator`.
A case that ships a pre-authored `conversation` already knows every user turn,
so it only needs those turns replayed. That is what the provider does: it
returns a `StaticUserSimulator` over the case's own conversation.

A case that describes a goal instead of a script carries a
`conversationScenario`, and its user turns are produced at eval time. The
provider cannot know which simulator should produce them, so it looks the
answer up in a registry keyed on the `type` discriminator of the simulator
config it was built with. adk-js ships no scenario simulator yet, so that
lookup misses until you register one. See
[Registering a simulator](#registering-a-simulator).

A case must carry exactly one of `conversation` and `conversationScenario`.
Carrying neither, or both, is an `InputValidationError`.

`generateResponses` uses the provider when the caller passes no
`createUserSimulator`, which is why an eval set of static conversations runs
with no simulator argument at all. A `createUserSimulator` that you do pass
replaces the provider entirely, so it is also how you drive a case that has no
static conversation today.

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

## Driving a case yourself

Pass `createUserSimulator` to replace the provider. This is the only way to run
a case that carries no static conversation.

```typescript
import {
  Event,
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
  generateResponses,
} from '@google/adk';

/** Asks one fixed question, then ends the conversation. */
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

await generateResponses({
  evalSet,
  agentModulePath: './weather_agent.js',
  createUserSimulator: () => new OneShotSimulator('what is the weather?'),
});
```

## Registering a simulator

A scenario case is routed on the `type` field of the config the provider was
built with. Register the factory for that `type` once, when your module loads,
and the provider finds it. Nothing in adk-js needs to change.

```typescript
import {
  BaseUserSimulatorConfig,
  Event,
  EvalModel,
  evalModel,
  NextUserMessage,
  registerUserSimulator,
  unpackUserSimulatorConfig,
  UserSimulator,
  UserSimulatorProvider,
  UserSimulatorStatus,
} from '@google/adk';
import {z} from 'zod';

interface EchoSimulatorConfig extends BaseUserSimulatorConfig {
  type: 'echo';
  maxTurns: number;
}

const echoSimulatorConfigModel: EvalModel<EchoSimulatorConfig> = evalModel(
  {type: z.literal('echo'), maxTurns: z.number()},
  {name: 'EchoSimulatorConfig', extraKeys: 'allow'},
);

/** Repeats the scenario's starting prompt, up to `maxTurns` times. */
class EchoSimulator implements UserSimulator {
  private turns = 0;

  constructor(
    private readonly config: EchoSimulatorConfig,
    private readonly prompt: string,
  ) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    if (this.turns >= this.config.maxTurns) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    this.turns++;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text: this.prompt}]},
    };
  }
}

registerUserSimulator('echo', ({config, conversationScenario}) => {
  return new EchoSimulator(
    unpackUserSimulatorConfig(config, echoSimulatorConfigModel),
    conversationScenario.startingPrompt,
  );
});

const provider = new UserSimulatorProvider({type: 'echo', maxTurns: 2});
const simulator = provider.provide({
  evalId: 'scenario_case',
  conversationScenario: {
    startingPrompt: 'what is the weather?',
    conversationPlan: 'ask about the weather, then stop',
  },
});
```

`unpackUserSimulatorConfig` narrows the base config to your own shape. It
accepts either spelling of a field name on the wire, `maxTurns` or
`max_turns`, and throws ``Expect config of type `EchoSimulatorConfig`.`` when
the config is not yours, keeping the schema error as the `cause`.

`registerUserSimulator` writes to one registry shared by the whole process, so
call it once at module load. Registering the same `type` twice keeps the later
factory. Use `unregisterUserSimulator` to undo a registration, and
`registeredUserSimulatorTypes` to read the registry.

## Guarantees

- A static conversation always replays statically. A case carrying
  `conversation` gets a `StaticUserSimulator` even when a simulator is
  registered for the config's `type`.
- A bare `{}` config dispatches to nothing. Absence of `type` is not a
  discriminator, so a scenario case reports that no simulator is registered
  for `BaseUserSimulatorConfig` rather than picking a default. adk-python
  defaults to its LLM-backed simulator here; adk-js has none to default to.
- `StaticUserSimulator.getSimulationEvaluator()` returns `undefined`. A script
  cannot deviate, so there is nothing to score.
- One simulator per repeat. `generateResponses` calls `provide` once for every
  run of every case, because a simulator is stateful across the turns it
  drives. Each repeat therefore replays the conversation from its first turn.
- `StaticUserSimulator` never throws. Running past the last scripted turn
  returns `STOP_SIGNAL_DETECTED` with no message, which is how the generator
  learns the conversation is over. An empty conversation stops on the first
  call.
- The simulator ignores the conversation history it is given. The script is
  fixed, so the agent's replies cannot change what the user says next.
