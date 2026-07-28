/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Type-only symbols are imported via `import type` so esbuild's per-file TS
// transform classifies them correctly; mixing them into the value import below
// makes esbuild mis-elide adjacent value imports (dropping them at runtime).
import type {BaseLlm, Invocation, UserSimulator} from '@google/adk';
import {
  BaseUserSimulatorConfig,
  ConversationScenario,
  EvalCase,
  LlmAudioUserSimulator,
  LlmAudioUserSimulatorConfig,
  LlmBackedUserSimulator,
  LlmBackedUserSimulatorConfig,
  LLMRegistry,
  SIMULATOR_BY_CONFIG_TYPE,
  StaticUserSimulator,
  UserSimulatorProvider,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/** Reads the audio decorator's private inner text simulator for assertions. */
function wrappedTextSimulator(simulator: UserSimulator): UserSimulator {
  return (simulator as unknown as {textSimulator: UserSimulator}).textSimulator;
}

const TEST_CONVERSATION: Invocation[] = [
  {invocationId: 'inv1', userContent: {parts: [{text: 'Hello!'}]}},
];

function makeScenario(): ConversationScenario {
  return new ConversationScenario({
    startingPrompt: 'Hello!',
    conversationPlan: 'test plan',
  });
}

describe('UserSimulatorProvider', () => {
  beforeEach(() => {
    // The LLM-backed simulator resolves a model in its constructor.
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue({} as unknown as BaseLlm);
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

  it('registers the built-in LlmAudioUserSimulator on import', () => {
    expect(SIMULATOR_BY_CONFIG_TYPE.get(LlmAudioUserSimulatorConfig)).toBe(
      LlmAudioUserSimulator,
    );
  });

  it('wraps a scenario simulator in the audio decorator for an audio config', () => {
    const scenario = makeScenario();
    const provider = new UserSimulatorProvider(
      new LlmAudioUserSimulatorConfig(),
    );
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversationScenario: scenario,
    });
    const simulator = provider.provide(evalCase);
    expect(simulator).toBeInstanceOf(LlmAudioUserSimulator);
    const inner = wrappedTextSimulator(simulator);
    expect(inner).toBeInstanceOf(LlmBackedUserSimulator);
    expect((inner as LlmBackedUserSimulator).conversationScenario).toBe(
      scenario,
    );
  });

  it('wraps a static conversation in the audio decorator for an audio config', () => {
    const provider = new UserSimulatorProvider(
      new LlmAudioUserSimulatorConfig(),
    );
    const evalCase = new EvalCase({
      evalId: 'test_eval_id',
      conversation: TEST_CONVERSATION,
    });
    const simulator = provider.provide(evalCase);
    expect(simulator).toBeInstanceOf(LlmAudioUserSimulator);
    const inner = wrappedTextSimulator(simulator);
    expect(inner).toBeInstanceOf(StaticUserSimulator);
    expect((inner as StaticUserSimulator).staticConversation).toBe(
      TEST_CONVERSATION,
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
