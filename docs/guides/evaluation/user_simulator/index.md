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

adk-python also routes a case that describes a goal instead of a script to a
model-backed simulator. adk-js has that simulator,
[`LlmBackedUserSimulator`](../llm_backed_user_simulator/index.md), but the
provider does not route to it yet: a case with no conversation is still
rejected with `InputValidationError` rather than guessed at. Pass the
simulator through `createUserSimulator` to drive such a case.

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

## Guarantees

- One simulator per repeat. `generateResponses` calls `provide` once for every
  run of every case, because a simulator is stateful across the turns it
  drives. Each repeat therefore replays the conversation from its first turn.
- `StaticUserSimulator` never throws. Running past the last scripted turn
  returns `STOP_SIGNAL_DETECTED` with no message, which is how the generator
  learns the conversation is over. An empty conversation stops on the first
  call.
- The simulator ignores the conversation history it is given. The script is
  fixed, so the agent's replies cannot change what the user says next.
