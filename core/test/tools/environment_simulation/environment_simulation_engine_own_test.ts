/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `EnvironmentSimulationEngine` behaviour that adk-python's suite
 * does not reach: argument matching, the probability draw, when the analysis
 * runs, and the strategy factory's rejection path.
 */

import {
  EnvironmentSimulationEngine,
  InputValidationError,
  LlmAgent,
  Logger,
  MockStrategy,
  ToolSimulationConfigParams,
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
  getLogger,
  setLogger,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createMockStrategy} from '../../../src/tools/environment_simulation/environment_simulation_engine.js';

import {
  FAKE_SIMULATION_MODEL,
  RecordingLogger,
  UncallableTool,
  capturedRequests,
  createToolContext,
  scriptModel,
} from './simulation_test_support.js';

import {SeededRandomGenerator} from '../../../src/utils/random_utils.js';

let previousLogger: Logger;

beforeEach(() => {
  previousLogger = getLogger();
  setLogger(new RecordingLogger());
});

afterEach(() => {
  setLogger(previousLogger);
});

function engineFor(
  ...toolConfigs: ToolSimulationConfigParams[]
): EnvironmentSimulationEngine {
  return new EnvironmentSimulationEngine(
    createEnvironmentSimulationConfig({
      toolSimulationConfigs: toolConfigs.map(createToolSimulationConfig),
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    }),
  );
}

/** The text of the single prompt the fake model was sent. */
function onlyPromptText(): string {
  expect(capturedRequests).toHaveLength(1);
  const parts = capturedRequests[0].contents[0].parts;
  expect(parts).toBeDefined();
  return parts?.[0].text ?? '';
}

describe('EnvironmentSimulationEngine argument matching', () => {
  it('matches an object-valued rule by structure, not by identity', async () => {
    const engine = engineFor({
      toolName: 'search',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {filter: {a: 1}},
          injectedResponse: {injected: true},
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('search'),
      args: {filter: {a: 1}},
      context: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });

  it('does not match when a required key is absent from the arguments', async () => {
    const engine = engineFor({
      toolName: 'search',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {ticketId: 'T-1'},
          injectedResponse: {injected: true},
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('search'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('does not match an inherited property name', async () => {
    // `'toString' in args` holds for every object, and the inherited function
    // equals itself, so a rule naming it would fire on every call. A rule key
    // is compared against the call's own arguments only.
    const engine = engineFor({
      toolName: 'search',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {toString: Object.prototype.toString},
          injectedResponse: {injected: true},
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('search'),
      args: {query: 'cats'},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('fires a rule that names a subset of the arguments', async () => {
    const engine = engineFor({
      toolName: 'search',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {query: 'cats'},
          injectedResponse: {injected: true},
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('search'),
      args: {query: 'cats', limit: 10},
      context: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });
});

describe('EnvironmentSimulationEngine injection probability', () => {
  it('never fires a rule whose probability is 0', async () => {
    const engine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: 0,
          injectedResponse: {injected: true},
        }),
      ],
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await engine.simulate({
        tool: new UncallableTool('test_tool'),
        args: {},
        context: createToolContext(),
      });
      expect(result).toBeUndefined();
    }
  });

  it('does not fire a rule whose probability equals the draw', async () => {
    // The draw has to clear the probability, not merely match it. A random
    // draw never lands on the boundary, so the test reproduces the draw the
    // seed produces and uses it as the probability.
    const seed = 42;
    const generator = new SeededRandomGenerator();
    generator.seed(seed);
    const drawForSeed = generator.next();
    const engine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: drawForSeed,
          randomSeed: seed,
          injectedResponse: {injected: true},
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('always fires a rule whose probability is 1', async () => {
    const engine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: 1,
          injectedResponse: {injected: true},
        }),
      ],
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await engine.simulate({
        tool: new UncallableTool('test_tool'),
        args: {},
        context: createToolContext(),
      });
      expect(result).toEqual({injected: true});
    }
  });

  it('returns an injected error under the camelCase keys adk-js produces', async () => {
    const engine = engineFor({
      toolName: 'get_ticket',
      injectionConfigs: [
        createInjectionConfig({
          injectedError: {
            injectedHttpErrorCode: 404,
            errorMessage: 'no such ticket',
          },
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('get_ticket'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toEqual({errorCode: 404, errorMessage: 'no such ticket'});
  });

  it('tries the next rule when a matching rule injects an empty response', async () => {
    // adk-python reads an empty dict as falsy and falls through, and the
    // config module already counts an empty response as unset. The config
    // factories reject one, so this only reaches a hand-built config.
    const engine = new EnvironmentSimulationEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {
              injectionProbability: 1,
              injectedLatencySeconds: 0,
              injectedResponse: {},
            },
            {
              injectionProbability: 1,
              injectedLatencySeconds: 0,
              injectedResponse: {second: true},
            },
          ],
          mockStrategyType: MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
        },
      ],
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });

    const result = await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toEqual({second: true});
  });

  it('replays the same decisions for two engines built from one seeded config', async () => {
    scriptModel('{"mocked": true}');
    const toolConfig: ToolSimulationConfigParams = {
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: 0.5,
          randomSeed: 7,
          injectedResponse: {injected: true},
        }),
        createInjectionConfig({
          injectionProbability: 0.5,
          injectedResponse: {second: true},
        }),
      ],
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    };

    const first: Array<Record<string, unknown> | undefined> = [];
    const second: Array<Record<string, unknown> | undefined> = [];
    for (const decisions of [first, second]) {
      const engine = engineFor(toolConfig);
      for (let call = 0; call < 3; call++) {
        decisions.push(
          await engine.simulate({
            tool: new UncallableTool('test_tool'),
            args: {},
            context: createToolContext(),
          }),
        );
      }
    }

    expect(first).toEqual(second);
    expect(first[0]).toEqual({injected: true});
  });
});

describe('EnvironmentSimulationEngine tool connection analysis', () => {
  function llmAgent(): LlmAgent {
    return new LlmAgent({
      name: 'support',
      model: FAKE_SIMULATION_MODEL,
      tools: [new UncallableTool('create_ticket')],
    });
  }

  it('analyzes the agent tools once across two calls', async () => {
    scriptModel(
      '{"statefulParameters": [{"parameterName": "ticket_id",' +
        ' "creatingTools": ["create_ticket"], "consumingTools": []}]}',
    );
    const engine = engineFor({
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TRACING,
    });
    const context = createToolContext(llmAgent());

    await engine.simulate({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context,
    });
    await engine.simulate({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context,
    });

    // Only the analysis calls the model; MOCK_STRATEGY_TRACING never does.
    expect(capturedRequests).toHaveLength(1);
  });

  it('does not analyze when every tool has no mock strategy', async () => {
    scriptModel('{"statefulParameters": []}');
    const engine = engineFor({
      toolName: 'create_ticket',
      injectionConfigs: [
        createInjectionConfig({injectedResponse: {injected: true}}),
      ],
      mockStrategyType: MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    });

    await engine.simulate({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(llmAgent()),
    });

    expect(capturedRequests).toHaveLength(0);
  });

  it('marks the analysis done when the agent is not an LlmAgent', async () => {
    scriptModel('{"statefulParameters": []}');
    const engine = engineFor({
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TRACING,
    });
    const context = createToolContext();

    await engine.simulate({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context,
    });
    await engine.simulate({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context,
    });

    expect(capturedRequests).toHaveLength(0);
  });

  it('passes the connection map to the mock strategy', async () => {
    scriptModel(
      '{"statefulParameters": [{"parameterName": "ticket_id",' +
        ' "creatingTools": ["create_ticket"], "consumingTools": []}]}',
      '',
    );
    const engine = engineFor({
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    await engine.simulate({
      tool: new UncallableTool('create_ticket'),
      args: {},
      context: createToolContext(llmAgent()),
    });

    expect(capturedRequests).toHaveLength(2);
    const mockPrompt = capturedRequests[1].contents[0].parts?.[0].text ?? '';
    expect(mockPrompt).toContain('"parameterName": "ticket_id"');
  });
});

describe('EnvironmentSimulationEngine prompt content', () => {
  it('puts environmentData and tracing in their own prompt sections', async () => {
    scriptModel('{"mocked": true}');
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
        simulationModel: FAKE_SIMULATION_MODEL,
        simulationModelConfiguration: {},
        environmentData: '{"tickets": []}',
        tracing: '{"calls": []}',
      }),
    );

    await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
    });

    const prompt = onlyPromptText();
    expect(prompt).toContain('<environment_data>\n        {"tickets": []}');
    expect(prompt).toContain('<tracing>\n        {"calls": []}');
  });

  it('asks the simulation model for JSON without dropping the caller config', async () => {
    scriptModel('{"mocked": true}');
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
        simulationModel: FAKE_SIMULATION_MODEL,
        simulationModelConfiguration: {temperature: 0.25},
      }),
    );

    await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(capturedRequests[0].config).toEqual({
      temperature: 0.25,
      responseMimeType: 'application/json',
    });
    expect(capturedRequests[0].model).toBe(FAKE_SIMULATION_MODEL);
  });

  it('sends the prompt as a single user turn', async () => {
    scriptModel('{"mocked": true}');
    const engine = engineFor({
      toolName: 'test_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
    });

    const contents: Content[] = capturedRequests[0].contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
  });
});

describe('EnvironmentSimulationEngine model resolution', () => {
  it('builds an injection-only simulation without resolving a model', async () => {
    // The default simulation model is a Gemini, whose constructor demands an
    // API key. A simulation that only injects canned responses never calls a
    // model, so it must not need a credential to be built or to run.
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'get_ticket',
            injectionConfigs: [
              createInjectionConfig({injectedResponse: {injected: true}}),
            ],
          }),
        ],
      }),
    );

    const result = await engine.simulate({
      tool: new UncallableTool('get_ticket'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });

  it('reports an unresolvable model when the simulation first calls one', async () => {
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'get_ticket',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
        simulationModel: 'no-such-model',
      }),
    );

    await expect(
      engine.simulate({
        tool: new UncallableTool('get_ticket'),
        args: {},
        context: createToolContext(),
      }),
    ).rejects.toThrow('Model no-such-model not found.');
  });
});

describe('createMockStrategy', () => {
  it('rejects a tool that names no mock strategy', () => {
    expect(() =>
      createMockStrategy(
        MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
        FAKE_SIMULATION_MODEL,
        {},
      ),
    ).toThrow(InputValidationError);
    expect(() =>
      createMockStrategy(
        MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
        FAKE_SIMULATION_MODEL,
        {},
      ),
    ).toThrow('Unknown mock strategy type: MOCK_STRATEGY_UNSPECIFIED');
  });

  it('reports that the deprecated tracing strategy mocks nothing', async () => {
    const strategy = createMockStrategy(
      MockStrategy.MOCK_STRATEGY_TRACING,
      FAKE_SIMULATION_MODEL,
      {},
    );

    const result = await strategy.mock({
      tool: new UncallableTool('test_tool'),
      args: {},
      context: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({status: 'error', errorMessage: 'Not implemented'});
  });
});
