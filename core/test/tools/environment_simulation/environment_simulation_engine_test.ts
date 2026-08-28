/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEnvironmentSimulationCallback,
  EnvironmentSimulationConfig,
  EnvironmentSimulationEngine,
  getLogger,
  LlmAgent,
  MockStrategyType,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  capturedRequests,
  createToolContext,
  FakeTool,
  NonLlmAgent,
  resetScriptedModel,
  SCRIPTED_MODEL,
  scriptReply,
} from './simulation_test_utils.js';

const EMPTY_CONNECTION_MAP = '{"stateful_parameters": []}';

function createEngine(
  config: Omit<EnvironmentSimulationConfig, 'simulationModel'>,
): EnvironmentSimulationEngine {
  return new EnvironmentSimulationEngine({
    ...config,
    simulationModel: SCRIPTED_MODEL,
    simulationModelConfiguration: {},
  });
}

describe('EnvironmentSimulationEngine.simulate', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('lets an unconfigured tool run', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'configured_tool',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('unconfigured_tool'),
      {},
      createToolContext(),
    );

    expect(result).toBeUndefined();
  });

  it('injects the configured response when the arguments match', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {matchArgs: {param: 'value'}, injectedResponse: {injected: true}},
          ],
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {param: 'value'},
      createToolContext(),
    );

    expect(result).toEqual({injected: true});
  });

  it('compares a structured argument by value, not by reference', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {
              matchArgs: {filters: ['a', 'b']},
              injectedResponse: {injected: true},
            },
          ],
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {filters: ['a', 'b']},
      createToolContext(),
    );

    expect(result).toEqual({injected: true});
  });

  it('injects the configured error as an error payload', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'charge_card',
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
    });

    const result = await engine.simulate(
      new FakeTool('charge_card'),
      {},
      createToolContext(),
    );

    expect(result).toEqual({error_code: 503, error_message: 'upstream down'});
  });

  it('applies the first rule that fires', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {injectedResponse: {rule: 'first'}},
            {injectedResponse: {rule: 'second'}},
          ],
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {},
      createToolContext(),
    );

    expect(result).toEqual({rule: 'first'});
  });

  it('falls through to the mock strategy when the arguments do not match', async () => {
    scriptReply('{"mocked": true}');
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {matchArgs: {param: 'value'}, injectedResponse: {injected: true}},
          ],
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {param: 'different_value'},
      createToolContext(),
    );

    expect(result).toEqual({mocked: true});
  });

  it('uses the deprecated tracing strategy when it is configured', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TRACING,
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {},
      createToolContext(),
    );

    expect(result).toEqual({status: 'error', error_message: 'Not implemented'});
  });

  it('warns and lets the tool run when nothing fires and no strategy is set', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {matchArgs: {param: 'value'}, injectedResponse: {injected: true}},
          ],
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {param: 'different_value'},
      createToolContext(),
    );

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Tool 'test_tool' did not hit any injection config",
      ),
    );
    warn.mockRestore();
  });

  it('rejects an invalid config as it is constructed', () => {
    expect(() => createEngine({toolSimulationConfigs: []})).toThrowError(
      'toolSimulationConfigs must be provided.',
    );
  });
});

describe('EnvironmentSimulationEngine injection probability', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  function createSeededEngine(randomSeed: number): EnvironmentSimulationEngine {
    return createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {
              injectionProbability: 0.5,
              randomSeed,
              injectedResponse: {injected: true},
            },
          ],
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });
  }

  async function simulateSeeded(randomSeed: number) {
    scriptReply('{"mocked": true}');
    return createSeededEngine(randomSeed).simulate(
      new FakeTool('test_tool'),
      {},
      createToolContext(),
    );
  }

  it('repeats the same decision for the same seed', async () => {
    expect(await simulateSeeded(7)).toEqual(await simulateSeeded(7));
  });

  it('injects for a seed that draws below the probability', async () => {
    expect(await simulateSeeded(7)).toEqual({injected: true});
  });

  it('falls through for a seed that draws above the probability', async () => {
    expect(await simulateSeeded(1)).toEqual({mocked: true});
  });

  it('never injects at probability zero', async () => {
    scriptReply('{"mocked": true}');
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {injectionProbability: 0, injectedResponse: {injected: true}},
          ],
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {},
      createToolContext(),
    );

    expect(result).toEqual({mocked: true});
  });
});

describe('EnvironmentSimulationEngine injected latency', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('waits the configured seconds without blocking the event loop', async () => {
    vi.useFakeTimers();
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'test_tool',
          injectionConfigs: [
            {injectedLatencySeconds: 0.2, injectedResponse: {injected: true}},
          ],
        },
      ],
    });

    let settled = false;
    const pending = engine
      .simulate(new FakeTool('test_tool'), {}, createToolContext())
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({injected: true});
    vi.useRealTimers();
  });
});

describe('EnvironmentSimulationEngine connection analysis', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  function createAnalyzingEngine(): EnvironmentSimulationEngine {
    return createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'create_ticket',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });
  }

  function createAgentContext() {
    return createToolContext(
      new LlmAgent({
        name: 'support',
        model: SCRIPTED_MODEL,
        tools: [new FakeTool('create_ticket')],
      }),
    );
  }

  it('analyzes the tools once across two sequential calls', async () => {
    scriptReply(EMPTY_CONNECTION_MAP);
    scriptReply('{"ticket_id": "T-1"}');
    scriptReply('{"ticket_id": "T-2"}');
    const engine = createAnalyzingEngine();
    const context = createAgentContext();
    const tool = new FakeTool('create_ticket');

    await engine.simulate(tool, {}, context);
    await engine.simulate(tool, {}, context);

    expect(capturedRequests).toHaveLength(3);
  });

  it('analyzes the tools once across two concurrent calls', async () => {
    scriptReply(EMPTY_CONNECTION_MAP);
    scriptReply('{"ticket_id": "T-1"}');
    scriptReply('{"ticket_id": "T-2"}');
    const engine = createAnalyzingEngine();
    const context = createAgentContext();
    const tool = new FakeTool('create_ticket');

    await Promise.all([
      engine.simulate(tool, {}, context),
      engine.simulate(tool, {}, context),
    ]);

    expect(capturedRequests).toHaveLength(3);
  });

  it('shows a later call the entity an earlier call minted', async () => {
    scriptReply(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": ["create_ticket"], "consuming_tools": []}]}',
    );
    scriptReply('{"ticket_id": "T-1"}');
    scriptReply('{"ticket_id": "T-2"}');
    const engine = createAnalyzingEngine();
    const context = createAgentContext();
    const tool = new FakeTool('create_ticket');

    await engine.simulate(tool, {}, context);
    await engine.simulate(tool, {}, context);

    const lastPrompt = capturedRequests[2].contents[0].parts?.[0].text ?? '';
    expect(lastPrompt).toContain('"T-1"');
  });

  it('skips the analysis when no tool uses a mock strategy', async () => {
    const engine = createEngine({
      toolSimulationConfigs: [
        {
          toolName: 'create_ticket',
          injectionConfigs: [{injectedResponse: {injected: true}}],
        },
      ],
    });

    await engine.simulate(
      new FakeTool('create_ticket'),
      {},
      createAgentContext(),
    );

    expect(capturedRequests).toHaveLength(0);
  });

  it('mocks without a connection map when the invocation has no agent', async () => {
    scriptReply('{"ticket_id": "T-1"}');
    const engine = createAnalyzingEngine();

    const result = await engine.simulate(
      new FakeTool('create_ticket'),
      {},
      createToolContext(),
    );

    expect(result).toEqual({ticket_id: 'T-1'});
    expect(capturedRequests).toHaveLength(1);
  });

  it('mocks without a connection map when the agent is not an LlmAgent', async () => {
    scriptReply('{"ticket_id": "T-1"}');
    const engine = createAnalyzingEngine();
    const context = createToolContext(
      new NonLlmAgent({name: 'not_an_llm_agent'}),
    );

    const result = await engine.simulate(
      new FakeTool('create_ticket'),
      {},
      context,
    );

    expect(result).toEqual({ticket_id: 'T-1'});
    expect(capturedRequests).toHaveLength(1);
  });
});

describe('createEnvironmentSimulationCallback', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  function createCallback() {
    return createEnvironmentSimulationCallback({
      toolSimulationConfigs: [
        {
          toolName: 'create_ticket',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
      simulationModel: SCRIPTED_MODEL,
      simulationModelConfiguration: {},
    });
  }

  it('returns a callback an LlmAgent accepts', () => {
    const agent = new LlmAgent({
      name: 'support',
      model: SCRIPTED_MODEL,
      beforeToolCallback: createCallback(),
    });

    expect(agent.beforeToolCallback).toBeTypeOf('function');
  });

  it('simulates the configured tool', async () => {
    scriptReply('{"ticket_id": "T-1"}');

    const result = await createCallback()({
      tool: new FakeTool('create_ticket'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toEqual({ticket_id: 'T-1'});
  });

  it('lets an unconfigured tool run', async () => {
    const result = await createCallback()({
      tool: new FakeTool('other_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('shares one engine, so a later call sees the earlier state', async () => {
    scriptReply(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": ["create_ticket"], "consuming_tools": []}]}',
    );
    scriptReply('{"ticket_id": "T-1"}');
    scriptReply('{"ticket_id": "T-2"}');
    const callback = createCallback();
    const context = createToolContext(
      new LlmAgent({
        name: 'support',
        model: SCRIPTED_MODEL,
        tools: [new FakeTool('create_ticket')],
      }),
    );
    const call = {tool: new FakeTool('create_ticket'), args: {}, context};

    await callback(call);
    await callback(call);

    const secondPrompt = capturedRequests[2].contents[0].parts?.[0].text ?? '';
    expect(secondPrompt).toContain('"T-1"');
  });

  it('rejects an invalid config as it builds the callback', () => {
    expect(() =>
      createEnvironmentSimulationCallback({toolSimulationConfigs: []}),
    ).toThrowError('toolSimulationConfigs must be provided.');
  });
});
