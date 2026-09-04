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
  UserSimulator,
  UserSimulatorProvider,
  UserSimulatorStatus,
  parseBaseUserSimulatorConfig,
  registerUserSimulator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

const TEST_CONVERSATION = [turn('Hello!')];

const TEST_CONVERSATION_SCENARIO: ConversationScenario = {
  startingPrompt: 'Hello!',
  conversationPlan: 'test plan',
};

/** An eval case whose user turns are produced at eval time. */
function scenarioCase(): EvalCase {
  return {
    evalId: 'case_scenario',
    creationTimestamp: 0,
    conversationScenario: TEST_CONVERSATION_SCENARIO,
  };
}

/** A simulator that ends the conversation on its first turn. */
function stopImmediately(): UserSimulator {
  return {
    async getNextUserMessage() {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    },
  };
}

// Ported from `google/adk-python` `main`,
// `tests/unittests/evaluation/simulation/test_user_simulator_provider.py`.
// Each `it` title is the name of the reference test it came from.
describe('user_simulator_provider ported reference tests', () => {
  it('test_provide_static_user_simulator', async () => {
    const provider = new UserSimulatorProvider();

    const simulator = provider.provide({
      evalId: 'test_eval_id',
      creationTimestamp: 0,
      conversation: TEST_CONVERSATION,
    });

    expect(await firstMessage(simulator)).toBe('Hello!');
  });

  it('test_init_accepts_bare_base_config_but_provide_raises', () => {
    const provider = new UserSimulatorProvider({});

    expect(() => provider.provide(scenarioCase())).toThrow(
      'No UserSimulator registered for config type `BaseUserSimulatorConfig`.',
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
      'No UserSimulator registered for config type `unregistered`. Register ' +
        'one via `registerUserSimulator()`.',
    );
  });
});

describe('UserSimulatorProvider dispatch by config type', () => {
  it('builds the registered simulator with the config and the scenario', () => {
    const registered = stopImmediately();
    let seenConfig: BaseUserSimulatorConfig | undefined;
    let seenScenario: ConversationScenario | undefined;
    registerUserSimulator('recording_sim', ({config, conversationScenario}) => {
      seenConfig = config;
      seenScenario = conversationScenario;
      return registered;
    });
    const config = {type: 'recording_sim', model: 'gemini-2.5-pro'};
    const provider = new UserSimulatorProvider(config);

    const simulator = provider.provide(scenarioCase());

    expect(simulator).toBe(registered);
    expect(seenConfig).toEqual(config);
    expect(seenScenario).toEqual(TEST_CONVERSATION_SCENARIO);
  });

  it('names every registered type when the lookup misses', () => {
    registerUserSimulator('listed_sim', () => stopImmediately());
    const provider = new UserSimulatorProvider({type: 'absent_sim'});

    expect(() => provider.provide(scenarioCase())).toThrow(
      /Currently registered: \[[^\]]*\blisted_sim\b[^\]]*\]\./,
    );
  });

  it('replays a static conversation even when a simulator is registered', async () => {
    registerUserSimulator('ignored_sim', () => stopImmediately());
    const provider = new UserSimulatorProvider({type: 'ignored_sim'});

    const simulator = provider.provide(evalCase([turn('scripted')]));

    expect(await firstMessage(simulator)).toBe('scripted');
  });

  it('rejects a case that carries a conversation and a scenario', () => {
    const provider = new UserSimulatorProvider();
    const both: EvalCase = {
      evalId: 'case_both',
      creationTimestamp: 0,
      conversation: TEST_CONVERSATION,
      conversationScenario: TEST_CONVERSATION_SCENARIO,
    };

    expect(() => provider.provide(both)).toThrow(InputValidationError);
    expect(() => provider.provide(both)).toThrow(
      'Both static invocations and conversation scenario provided in ' +
        'EvalCase. Provide exactly one.',
    );
  });
});
