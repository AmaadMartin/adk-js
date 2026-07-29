/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseUserSimulatorConfig,
  ConversationScenario,
  EvalCase,
  Invocation,
  LlmBackedUserSimulator,
  LlmBackedUserSimulatorConfig,
  LLMRegistry,
  LlmResponse,
  SIMULATOR_BY_CONFIG_TYPE,
  StaticUserSimulator,
  UserSimulatorProvider,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const TEST_CONVERSATION: Invocation[] = [
  {invocationId: 'inv1', userContent: {parts: [{text: 'Hello!'}]}},
];

/**
 * A `BaseLlm` that is never driven: the provider only has to resolve a model
 * while constructing the simulator, it never generates.
 */
class UnusedLlm extends BaseLlm {
  constructor() {
    super({model: 'test-model'});
  }

  override generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('The provider never generates content.');
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('The provider never opens a live connection.');
  }
}

function makeScenario(): ConversationScenario {
  return new ConversationScenario({
    startingPrompt: 'Hello!',
    conversationPlan: 'test plan',
  });
}

describe('UserSimulatorProvider', () => {
  beforeEach(() => {
    // The LLM-backed simulator resolves a model in its constructor.
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new UnusedLlm());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provides a StaticUserSimulator for a static conversation', () => {
    const provider = new UserSimulatorProvider();
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversation: TEST_CONVERSATION,
    });
    const simulator = provider.provide(evalCase);
    expect(simulator).toBeInstanceOf(StaticUserSimulator);
    expect((simulator as StaticUserSimulator).staticConversation).toBe(
      TEST_CONVERSATION,
    );
  });

  it('provides an LlmBackedUserSimulator for a scenario (default config)', () => {
    const scenario = makeScenario();
    const provider = new UserSimulatorProvider();
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversationScenario: scenario,
    });
    const simulator = provider.provide(evalCase);
    expect(simulator).toBeInstanceOf(LlmBackedUserSimulator);
    expect((simulator as LlmBackedUserSimulator).conversationScenario).toBe(
      scenario,
    );
  });

  it('provides an LlmBackedUserSimulator for a scenario (explicit config)', () => {
    const provider = new UserSimulatorProvider(
      new LlmBackedUserSimulatorConfig({model: 'test_model'}),
    );
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversationScenario: makeScenario(),
    });
    const simulator = provider.provide(evalCase);
    expect(simulator).toBeInstanceOf(LlmBackedUserSimulator);
    expect((simulator as LlmBackedUserSimulator).config.model).toBe(
      'test_model',
    );
  });

  it('accepts a bare base config but throws on provide()', () => {
    const provider = new UserSimulatorProvider(new BaseUserSimulatorConfig());
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversationScenario: makeScenario(),
    });
    expect(() => provider.provide(evalCase)).toThrow(
      'No UserSimulator registered for config type `BaseUserSimulatorConfig`',
    );
  });

  it('rejects a non-config argument', () => {
    // The cast is the subject of the test: it stages the wrong-typed value a
    // JS caller can pass, so the constructor's runtime guard can be exercised.
    expect(
      () =>
        new UserSimulatorProvider(
          'not a config' as unknown as BaseUserSimulatorConfig,
        ),
    ).toThrow('Expect config of type `BaseUserSimulatorConfig`.');
  });

  it('defaults the base config type to undefined', () => {
    expect(new BaseUserSimulatorConfig().type).toBeUndefined();
  });

  it('locks the llm_backed config type literal', () => {
    expect(new LlmBackedUserSimulatorConfig().type).toBe('llm_backed');
    expect(
      () =>
        new LlmBackedUserSimulatorConfig({
          type: 'something_else' as 'llm_backed',
        }),
    ).toThrow();
  });

  it('registers the built-in LlmBackedUserSimulator on import', () => {
    expect(SIMULATOR_BY_CONFIG_TYPE.get(LlmBackedUserSimulatorConfig)).toBe(
      LlmBackedUserSimulator,
    );
  });

  it('throws for an unregistered config subclass', () => {
    class UnregisteredConfig extends BaseUserSimulatorConfig {}
    const provider = new UserSimulatorProvider(new UnregisteredConfig());
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversationScenario: makeScenario(),
    });
    expect(() => provider.provide(evalCase)).toThrow(
      'No UserSimulator registered for config type `UnregisteredConfig`',
    );
  });
});
