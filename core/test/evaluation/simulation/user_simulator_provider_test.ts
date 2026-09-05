/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseUserSimulatorConfig,
  ConversationScenario,
  EvalCase,
  InputValidationError,
  Invocation,
  NextUserMessage,
  StaticUserSimulator,
  UserSimulator,
  UserSimulatorFactory,
  UserSimulatorProvider,
  UserSimulatorStatus,
  parseBaseUserSimulatorConfig,
  registerUserSimulator,
  registeredUserSimulatorTypes,
  unregisterUserSimulator,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

function turn(text: string): Invocation {
  return {
    invocationId: `inv_${text}`,
    userContent: {role: 'user', parts: [{text}]},
  };
}

function evalCase(conversation?: Invocation[]): EvalCase {
  return {evalId: 'case_0', creationTimestamp: 0, conversation};
}

/** The first message the simulator produces. */
async function firstMessage(simulator: UserSimulator): Promise<string> {
  const next = await simulator.getNextUserMessage([]);
  return next.userMessage?.parts?.[0].text ?? '';
}

describe('UserSimulatorProvider', () => {
  it('replays a static conversation', async () => {
    const provider = new UserSimulatorProvider();

    const simulator = provider.provide(evalCase([turn('scripted')]));

    expect(await firstMessage(simulator)).toBe('scripted');
  });

  it('accepts an empty conversation rather than rejecting it', async () => {
    const provider = new UserSimulatorProvider();

    const simulator = provider.provide(evalCase([]));

    expect(await firstMessage(simulator)).toBe('');
  });

  it('rejects a case that carries no conversation', () => {
    const provider = new UserSimulatorProvider();

    expect(() => provider.provide(evalCase())).toThrow(InputValidationError);
    expect(() => provider.provide(evalCase())).toThrow(
      'Neither static invocations nor conversation scenario provided in ' +
        'EvalCase. Provide exactly one.',
    );
  });

  it('builds a fresh simulator on every call for the same case', async () => {
    const provider = new UserSimulatorProvider();
    const sharedCase = evalCase([turn('only')]);

    const first = provider.provide(sharedCase);
    await first.getNextUserMessage([]);
    const second = provider.provide(sharedCase);

    expect(second).not.toBe(first);
    expect(await firstMessage(second)).toBe('only');
  });
});

const SCENARIO: ConversationScenario = {
  startingPrompt: 'Hello!',
  conversationPlan: 'test plan',
};

function scenarioCase(): EvalCase {
  return {
    evalId: 'case_scenario',
    creationTimestamp: 0,
    conversationScenario: SCENARIO,
  };
}

/** Records what the provider handed the factory, so the test can assert it. */
interface FactoryCall {
  config: BaseUserSimulatorConfig;
  conversationScenario: ConversationScenario;
}

/** A factory that records its arguments and returns a labelled simulator. */
function recordingFactory(label: string): {
  factory: UserSimulatorFactory;
  calls: FactoryCall[];
} {
  const calls: FactoryCall[] = [];
  const factory: UserSimulatorFactory = (params) => {
    calls.push(params);
    return {
      async getNextUserMessage(): Promise<NextUserMessage> {
        return {
          status: UserSimulatorStatus.SUCCESS,
          userMessage: {role: 'user', parts: [{text: label}]},
        };
      },
    };
  };
  return {factory, calls};
}

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_user_simulator_provider.py`,
 * read at `main` (commit a3bd11152db6562054db1c509ec44509436d99e7). The `it`
 * titles keep the Python test names so the two suites stay comparable.
 *
 * Six of the eleven Python tests are not ported: three need
 * `_LlmAudioUserSimulator` and three need `LlmBackedUserSimulator`, and
 * neither simulator exists in adk-js yet.
 */
describe('user_simulator_provider ported reference tests', () => {
  it('test_provide_static_user_simulator', async () => {
    const provider = new UserSimulatorProvider();
    const conversation = [turn('scripted')];

    const simulator = provider.provide(evalCase(conversation));

    expect(simulator).toBeInstanceOf(StaticUserSimulator);
    expect(await firstMessage(simulator)).toBe('scripted');
  });

  it('test_init_accepts_bare_base_config_but_provide_raises', () => {
    const provider = new UserSimulatorProvider({});

    expect(() => provider.provide(scenarioCase())).toThrow(
      'No UserSimulator registered for config type `BaseUserSimulatorConfig`',
    );
  });

  it('test_init_rejects_non_config_argument', () => {
    expect(() => new UserSimulatorProvider('not a config')).toThrow(
      InputValidationError,
    );
    expect(() => new UserSimulatorProvider('not a config')).toThrow(
      'Expect config of type `BaseUserSimulatorConfig`.',
    );
  });

  it('test_base_config_type_defaults_to_none', () => {
    expect(parseBaseUserSimulatorConfig({}).type).toBeUndefined();
  });

  it('test_provide_raises_for_unregistered_config_type', () => {
    const provider = new UserSimulatorProvider({type: 'unregistered'});

    expect(() => provider.provide(scenarioCase())).toThrow(
      'No UserSimulator registered for config type `unregistered`',
    );
  });
});

describe('UserSimulatorProvider config-driven dispatch', () => {
  afterEach(() => {
    for (const configType of registeredUserSimulatorTypes()) {
      unregisterUserSimulator(configType);
    }
  });

  it('routes a scenario case to the simulator registered for its type', async () => {
    const {factory, calls} = recordingFactory('generated');
    registerUserSimulator('demo', factory);
    const provider = new UserSimulatorProvider({type: 'demo', maxTurns: 4});

    const simulator = provider.provide(scenarioCase());

    expect(await firstMessage(simulator)).toBe('generated');
    expect(calls).toEqual([
      {
        config: {type: 'demo', maxTurns: 4},
        conversationScenario: SCENARIO,
      },
    ]);
  });

  it('replays statically even when a simulator is registered for the type', async () => {
    const {factory, calls} = recordingFactory('generated');
    registerUserSimulator('demo', factory);
    const provider = new UserSimulatorProvider({type: 'demo'});

    const simulator = provider.provide(evalCase([turn('scripted')]));

    expect(simulator).toBeInstanceOf(StaticUserSimulator);
    expect(await firstMessage(simulator)).toBe('scripted');
    expect(calls).toEqual([]);
  });

  it('names every registered type when the lookup misses', () => {
    registerUserSimulator('zulu', recordingFactory('zulu').factory);
    registerUserSimulator('alpha', recordingFactory('alpha').factory);
    const provider = new UserSimulatorProvider({type: 'missing'});

    expect(() => provider.provide(scenarioCase())).toThrow(
      'No UserSimulator registered for config type `missing`. Register one ' +
        'via `registerUserSimulator()`. Currently registered: alpha, zulu.',
    );
  });

  it('says so when nothing at all is registered', () => {
    const provider = new UserSimulatorProvider({type: 'missing'});

    expect(() => provider.provide(scenarioCase())).toThrow(
      'No UserSimulator registered for config type `missing`. Register one ' +
        'via `registerUserSimulator()`. Currently registered: none.',
    );
  });

  it('builds a fresh simulator per call for the same scenario case', () => {
    const {factory} = recordingFactory('generated');
    registerUserSimulator('demo', factory);
    const provider = new UserSimulatorProvider({type: 'demo'});
    const sharedCase = scenarioCase();

    expect(provider.provide(sharedCase)).not.toBe(provider.provide(sharedCase));
  });

  it('rejects a case that carries a conversation and a scenario', () => {
    const provider = new UserSimulatorProvider();
    const both: EvalCase = {
      evalId: 'case_both',
      creationTimestamp: 0,
      conversation: [turn('scripted')],
      conversationScenario: SCENARIO,
    };

    expect(() => provider.provide(both)).toThrow(InputValidationError);
    expect(() => provider.provide(both)).toThrow(
      'Both static invocations and conversation scenario provided in ' +
        'EvalCase. Provide exactly one.',
    );
  });
});
