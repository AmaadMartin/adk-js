/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  EnvironmentSimulationConfigInput,
  EnvironmentSimulationEngine,
  FeatureName,
  LLMRegistry,
  LlmAgent,
  MockStrategy,
  SequentialAgent,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../../src/utils/logger.js';

import {
  RecordingLlm,
  StubTool,
  createToolContext,
  promptOf,
  promptText,
  stubRegistryWith,
  textResponses,
} from './environment_simulation_test_utils.js';

const CREATE_TICKET = new StubTool('create_ticket', {
  name: 'create_ticket',
  description: 'Creates a ticket.',
});
const GET_TICKET = new StubTool('get_ticket', {
  name: 'get_ticket',
  description: 'Reads a ticket.',
});
const UNCONFIGURED_TOOL = new StubTool('send_email', {
  name: 'send_email',
  description: 'Sends an email.',
});

const CONNECTION_MAP_JSON = JSON.stringify({
  stateful_parameters: [
    {
      parameter_name: 'ticket_id',
      creating_tools: ['create_ticket'],
      consuming_tools: ['get_ticket'],
    },
  ],
});
const MOCK_RESPONSE_JSON = '{"ticket_id": "T-1"}';

/** Marker text unique to the tool connection analysis prompt. */
const ANALYSIS_MARKER = 'expert software architect';

/** Mulberry32 draws 0.011705 first for seed 7 and 0.627074 for seed 1. */
const SEED_BELOW_HALF = 7;
const SEED_ABOVE_HALF = 1;

let toolContext: Context;

function toolSpecEngine(
  toolName: string,
  overrides: Partial<EnvironmentSimulationConfigInput> = {},
): EnvironmentSimulationEngine {
  return new EnvironmentSimulationEngine({
    toolSimulationConfigs: [
      {toolName, mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC},
    ],
    simulationModel: 'test-model',
    simulationModelConfiguration: {},
    ...overrides,
  });
}

/** Lets every already-queued microtask run without advancing a fake clock. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function analysisPromptCount(llm: RecordingLlm): number {
  return llm.requests.filter((request) =>
    promptText(request).includes(ANALYSIS_MARKER),
  ).length;
}

/**
 * Answers the analysis prompt with a connection map and every other prompt
 * with a mock tool response, so tests do not depend on call ordering.
 */
function stubSimulationModel(): RecordingLlm {
  return stubRegistryWith((request) =>
    textResponses([
      promptText(request).includes(ANALYSIS_MARKER)
        ? CONNECTION_MAP_JSON
        : MOCK_RESPONSE_JSON,
    ]),
  );
}

describe('EnvironmentSimulationEngine', () => {
  beforeEach(() => {
    toolContext = createToolContext(
      new LlmAgent({name: 'root', tools: [CREATE_TICKET, GET_TICKET]}),
    );
  });

  afterEach(() => {
    // Restore spies before uninstalling the fake timers: a `setTimeout` spy
    // installed under fake timers otherwise restores the fake implementation
    // on top of the real one and leaks a frozen clock into the next test.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('feature gating and validation', () => {
    it('constructs while the feature is enabled by default', () => {
      stubSimulationModel();

      expect(() => toolSpecEngine('create_ticket')).not.toThrow();
    });

    it('throws while the feature is disabled', async () => {
      stubSimulationModel();

      await withTemporaryFeatureOverride(
        FeatureName.ENVIRONMENT_SIMULATION,
        false,
        () => {
          expect(() => toolSpecEngine('create_ticket')).toThrow(
            'Feature ENVIRONMENT_SIMULATION is not enabled.',
          );
        },
      );
    });

    it('does not resolve the simulation model at construction', () => {
      const newLlm = vi.spyOn(LLMRegistry, 'newLlm');

      toolSpecEngine('create_ticket');

      expect(newLlm).not.toHaveBeenCalled();
    });

    it('rejects an invalid configuration at construction', () => {
      stubSimulationModel();

      expect(
        () =>
          new EnvironmentSimulationEngine({
            toolSimulationConfigs: [{toolName: 'create_ticket'}],
          }),
      ).toThrow();
    });
  });

  describe('tool selection', () => {
    it('returns undefined for a tool that is not configured', async () => {
      const llm = stubSimulationModel();
      const engine = toolSpecEngine('create_ticket');

      const result = await engine.simulate({
        tool: UNCONFIGURED_TOOL,
        args: {},
        toolContext,
      });

      expect(result).toBeUndefined();
      expect(llm.requests).toEqual([]);
    });
  });

  describe('injection matching', () => {
    async function simulateWithMatchArgs(
      matchArgs: Record<string, unknown>,
      args: Record<string, unknown>,
    ) {
      stubSimulationModel();
      const engine = toolSpecEngine('create_ticket', {
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [{matchArgs, injectedResponse: {injected: true}}],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          },
        ],
      });
      return engine.simulate({tool: CREATE_TICKET, args, toolContext});
    }

    it('injects when matchArgs is a subset of the arguments', async () => {
      await expect(
        simulateWithMatchArgs({param: 'value'}, {param: 'value', extra: 1}),
      ).resolves.toEqual({injected: true});
    });

    it('falls back to the mock strategy when a matchArgs value differs', async () => {
      await expect(
        simulateWithMatchArgs({param: 'value'}, {param: 'other'}),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });

    it('falls back to the mock strategy when a matchArgs key is absent', async () => {
      await expect(
        simulateWithMatchArgs({param: 'value'}, {other: 'value'}),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });

    it('does not treat an inherited key as present in the arguments', async () => {
      // `'constructor' in args` is true for every object and reads back the
      // Object constructor, so an `in` test plus a structural comparison would
      // match arguments that carry no such key at all.
      await expect(
        simulateWithMatchArgs({constructor: Object}, {param: 'value'}),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });

    it('does not treat an inherited method as present in the arguments', async () => {
      await expect(
        simulateWithMatchArgs(
          {toString: Object.prototype.toString},
          {param: 'value'},
        ),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });

    it('requires every matchArgs entry to match, not just one', async () => {
      await expect(
        simulateWithMatchArgs({a: 1, b: 2}, {a: 1, b: 999}),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });

    it('injects when every matchArgs entry matches', async () => {
      await expect(
        simulateWithMatchArgs({a: 1, b: 2}, {a: 1, b: 2}),
      ).resolves.toEqual({injected: true});
    });

    it('matches an object matchArgs value by deep equality', async () => {
      await expect(
        simulateWithMatchArgs(
          {filters: {status: 'open'}},
          {filters: {status: 'open'}},
        ),
      ).resolves.toEqual({injected: true});
    });

    it('matches an array matchArgs value by deep equality', async () => {
      await expect(
        simulateWithMatchArgs({tags: ['a', 'b']}, {tags: ['a', 'b']}),
      ).resolves.toEqual({injected: true});
    });

    it('does not match an array matchArgs value of different content', async () => {
      await expect(
        simulateWithMatchArgs({tags: ['a', 'b']}, {tags: ['a', 'c']}),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });
  });

  describe('injected payloads', () => {
    it('returns exactly error_code and error_message for an injected error', async () => {
      stubSimulationModel();
      const engine = new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [
              {
                injectedError: {
                  injectedHttpErrorCode: 503,
                  errorMessage: 'upstream down',
                },
              },
            ],
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });

      const result = await engine.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext,
      });

      expect(result).toEqual({
        error_code: 503,
        error_message: 'upstream down',
      });
    });

    it('returns an empty injected response, short-circuiting the tool', async () => {
      // Documented divergence: adk-python's truthiness check treats an empty
      // dict as unset and rejects the config, while the zod refine tests for
      // presence. An empty object is not nullish, so `functions.ts` still
      // short-circuits the real tool with it.
      stubSimulationModel();
      const engine = new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [{injectedResponse: {}}],
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });

      const result = await engine.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext,
      });

      expect(result).toEqual({});
      expect(result).toBeDefined();
    });

    it('returns the injected response unchanged', async () => {
      stubSimulationModel();
      const engine = new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [
              {injectedResponse: {nested: {ok: true}, list: [1, 2]}},
            ],
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });

      const result = await engine.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext,
      });

      expect(result).toEqual({nested: {ok: true}, list: [1, 2]});
    });
  });

  describe('injection probability', () => {
    function probabilityEngine(
      injectionProbability: number,
      randomSeed?: number,
    ) {
      return toolSpecEngine('create_ticket', {
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [
              {
                injectionProbability,
                randomSeed,
                injectedResponse: {injected: true},
              },
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          },
        ],
      });
    }

    it('always injects at a probability of 1', async () => {
      stubSimulationModel();
      const engine = probabilityEngine(1);

      for (let i = 0; i < 5; i++) {
        await expect(
          engine.simulate({tool: CREATE_TICKET, args: {}, toolContext}),
        ).resolves.toEqual({injected: true});
      }
    });

    it('never injects at a probability of 0', async () => {
      stubSimulationModel();
      const engine = probabilityEngine(0);

      for (let i = 0; i < 5; i++) {
        await expect(
          engine.simulate({tool: CREATE_TICKET, args: {}, toolContext}),
        ).resolves.toEqual({ticket_id: 'T-1'});
      }
    });

    it('injects for a seed whose first draw is below the probability', async () => {
      stubSimulationModel();
      const engine = probabilityEngine(0.5, SEED_BELOW_HALF);

      await expect(
        engine.simulate({tool: CREATE_TICKET, args: {}, toolContext}),
      ).resolves.toEqual({injected: true});
    });

    it('does not inject for a seed whose first draw is above the probability', async () => {
      stubSimulationModel();
      const engine = probabilityEngine(0.5, SEED_ABOVE_HALF);

      await expect(
        engine.simulate({tool: CREATE_TICKET, args: {}, toolContext}),
      ).resolves.toEqual({ticket_id: 'T-1'});
    });

    it('is stable across repeated calls on one seeded engine', async () => {
      stubSimulationModel();
      const engine = probabilityEngine(0.5, SEED_BELOW_HALF);

      const results: Array<Record<string, unknown> | undefined> = [];
      for (let i = 0; i < 3; i++) {
        results.push(
          await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext}),
        );
      }

      expect(results).toEqual([
        {injected: true},
        {injected: true},
        {injected: true},
      ]);
    });

    it('is identical for two engines built from the same seeded config', async () => {
      stubSimulationModel();
      const first = probabilityEngine(0.5, SEED_ABOVE_HALF);
      const second = probabilityEngine(0.5, SEED_ABOVE_HALF);

      const firstResult = await first.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext,
      });
      const secondResult = await second.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext,
      });

      expect(firstResult).toEqual(secondResult);
    });

    it('draws the next value of a seeded stream for a later unseeded config', async () => {
      // Seed 1 draws 0.627074 then 0.002736. Only the second draw is below
      // 0.01, so the second injection can fire only if the seeded generator
      // persisted instead of being reseeded or replaced by Math.random.
      stubSimulationModel();
      const engine = toolSpecEngine('create_ticket', {
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [
              {
                randomSeed: SEED_ABOVE_HALF,
                injectionProbability: 0.01,
                injectedResponse: {first: true},
              },
              {
                injectionProbability: 0.01,
                injectedResponse: {second: true},
              },
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          },
        ],
      });

      await expect(
        engine.simulate({tool: CREATE_TICKET, args: {}, toolContext}),
      ).resolves.toEqual({second: true});
    });
  });

  describe('injected latency', () => {
    function latencyEngine(injectedLatencySeconds: number) {
      return new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [
              {injectedLatencySeconds, injectedResponse: {injected: true}},
            ],
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });
    }

    it('resolves only once the injected latency has elapsed', async () => {
      stubSimulationModel();
      const engine = latencyEngine(0.2);
      vi.useFakeTimers();

      let settled = false;
      const pending = engine
        .simulate({tool: CREATE_TICKET, args: {}, toolContext})
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(199);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({injected: true});
    });

    it('still awaits a timer for a latency of zero', async () => {
      stubSimulationModel();
      const engine = latencyEngine(0);
      vi.useFakeTimers();

      let settled = false;
      const pending = engine
        .simulate({tool: CREATE_TICKET, args: {}, toolContext})
        .then((result) => {
          settled = true;
          return result;
        });
      await flushMicrotasks();

      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual({injected: true});
    });
  });

  describe('mock strategy fallback', () => {
    it('warns and returns undefined when nothing hits and no strategy is set', async () => {
      const llm = stubSimulationModel();
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const engine = new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [
              {
                matchArgs: {param: 'value'},
                injectedResponse: {injected: true},
              },
            ],
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });

      const result = await engine.simulate({
        tool: CREATE_TICKET,
        args: {param: 'other'},
        toolContext,
      });

      expect(result).toBeUndefined();
      expect(llm.requests).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'did not hit any injection config and has no mock strategy',
        ),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('create_ticket'),
      );
    });

    it('passes the analyzed map, environment data and tracing to the strategy', async () => {
      const llm = stubSimulationModel();
      const engine = toolSpecEngine('create_ticket', {
        environmentData: '{"tickets": []}',
        tracing: '{"events": []}',
      });

      await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext});

      const mockPrompt = promptOf(llm, 1);
      expect(mockPrompt).toContain('"parameterName": "ticket_id"');
      expect(mockPrompt).toContain('{"tickets": []}');
      expect(mockPrompt).toContain('{"events": []}');
    });

    it('shares one state store across calls', async () => {
      const llm = stubSimulationModel();
      const engine = new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          },
          {
            toolName: 'get_ticket',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });

      await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext});
      // The consuming call carries no id in its arguments, so the entity can
      // only reach its prompt through the engine's shared state store.
      await engine.simulate({
        tool: GET_TICKET,
        args: {query: 'latest'},
        toolContext,
      });

      expect(promptOf(llm, 2)).toContain(
        JSON.stringify({'ticket_id': {'T-1': {ticket_id: 'T-1'}}}, null, 2),
      );
    });
  });

  describe('tool connection analysis', () => {
    it('analyzes at most once per engine', async () => {
      const llm = stubSimulationModel();
      const engine = toolSpecEngine('create_ticket');

      await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext});
      await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext});

      expect(analysisPromptCount(llm)).toBe(1);
      expect(llm.requests).toHaveLength(3);
    });

    it('skips the analysis when no tool has a mock strategy', async () => {
      const llm = stubSimulationModel();
      const engine = new EnvironmentSimulationEngine({
        toolSimulationConfigs: [
          {
            toolName: 'create_ticket',
            injectionConfigs: [{injectedResponse: {injected: true}}],
          },
        ],
        simulationModel: 'test-model',
        simulationModelConfiguration: {},
      });

      await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext});

      expect(analysisPromptCount(llm)).toBe(0);
    });

    it('skips the analysis when the agent is not an LlmAgent but still simulates', async () => {
      const llm = stubSimulationModel();
      const engine = toolSpecEngine('create_ticket');

      const result = await engine.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext: createToolContext(new SequentialAgent({name: 'root'})),
      });

      expect(analysisPromptCount(llm)).toBe(0);
      expect(result).toEqual({ticket_id: 'T-1'});
    });

    it('latches after a non-LlmAgent call, matching adk-python', async () => {
      const llm = stubSimulationModel();
      const engine = toolSpecEngine('create_ticket');

      await engine.simulate({
        tool: CREATE_TICKET,
        args: {},
        toolContext: createToolContext(new SequentialAgent({name: 'root'})),
      });
      await engine.simulate({tool: CREATE_TICKET, args: {}, toolContext});

      expect(analysisPromptCount(llm)).toBe(0);
    });
  });
});
