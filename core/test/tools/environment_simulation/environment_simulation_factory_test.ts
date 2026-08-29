/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EnvironmentSimulationConfigInput,
  EnvironmentSimulationFactory,
  FeatureName,
  LlmAgent,
  MockStrategy,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  RecordingLlm,
  StubTool,
  createToolContext,
  promptText,
  stubRegistryWith,
  textResponses,
} from './environment_simulation_test_utils.js';

const CREATE_TICKET = new StubTool('create_ticket', {
  name: 'create_ticket',
  description: 'Creates a ticket.',
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

const CONFIG: EnvironmentSimulationConfigInput = {
  toolSimulationConfigs: [
    {
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
  ],
  simulationModel: 'test-model',
  simulationModelConfiguration: {},
};

const ANALYSIS_MARKER = 'expert software architect';

function analysisPromptCount(llm: RecordingLlm): number {
  return llm.requests.filter((request) =>
    promptText(request).includes(ANALYSIS_MARKER),
  ).length;
}

function stubSimulationModel(): RecordingLlm {
  return stubRegistryWith((request) =>
    textResponses([
      promptText(request).includes(ANALYSIS_MARKER)
        ? CONNECTION_MAP_JSON
        : MOCK_RESPONSE_JSON,
    ]),
  );
}

function toolContext() {
  return createToolContext(
    new LlmAgent({name: 'root', tools: [CREATE_TICKET]}),
  );
}

describe('EnvironmentSimulationFactory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createCallback', () => {
    it('returns a callback simulating the configured tool', async () => {
      stubSimulationModel();
      const callback = EnvironmentSimulationFactory.createCallback(CONFIG);

      const result = await callback({
        tool: CREATE_TICKET,
        args: {},
        context: toolContext(),
      });

      expect(result).toEqual({ticket_id: 'T-1'});
    });

    it('reuses one engine across invocations', async () => {
      const llm = stubSimulationModel();
      const callback = EnvironmentSimulationFactory.createCallback(CONFIG);

      await callback({tool: CREATE_TICKET, args: {}, context: toolContext()});
      await callback({tool: CREATE_TICKET, args: {}, context: toolContext()});

      expect(analysisPromptCount(llm)).toBe(1);
    });

    it('builds the engine eagerly, so an invalid config throws up front', () => {
      stubSimulationModel();

      expect(() =>
        EnvironmentSimulationFactory.createCallback({
          toolSimulationConfigs: [],
        }),
      ).toThrow('toolSimulationConfigs must be provided.');
    });

    it('propagates the disabled feature gate', async () => {
      stubSimulationModel();

      await withTemporaryFeatureOverride(
        FeatureName.ENVIRONMENT_SIMULATION,
        false,
        () => {
          expect(() =>
            EnvironmentSimulationFactory.createCallback(CONFIG),
          ).toThrow('Feature ENVIRONMENT_SIMULATION is not enabled.');
        },
      );
    });
  });

  describe('createPlugin', () => {
    it('returns a plugin simulating the configured tool', async () => {
      stubSimulationModel();
      const plugin = EnvironmentSimulationFactory.createPlugin(CONFIG);

      const result = await plugin.beforeToolCallback({
        tool: CREATE_TICKET,
        toolArgs: {},
        toolContext: toolContext(),
      });

      expect(plugin.name).toBe('EnvironmentSimulation');
      expect(result).toEqual({ticket_id: 'T-1'});
    });

    it('reuses one engine across tool calls', async () => {
      const llm = stubSimulationModel();
      const plugin = EnvironmentSimulationFactory.createPlugin(CONFIG);

      await plugin.beforeToolCallback({
        tool: CREATE_TICKET,
        toolArgs: {},
        toolContext: toolContext(),
      });
      await plugin.beforeToolCallback({
        tool: CREATE_TICKET,
        toolArgs: {},
        toolContext: toolContext(),
      });

      expect(analysisPromptCount(llm)).toBe(1);
    });

    it('propagates the disabled feature gate', async () => {
      stubSimulationModel();

      await withTemporaryFeatureOverride(
        FeatureName.ENVIRONMENT_SIMULATION,
        false,
        () => {
          expect(() =>
            EnvironmentSimulationFactory.createPlugin(CONFIG),
          ).toThrow('Feature ENVIRONMENT_SIMULATION is not enabled.');
        },
      );
    });
  });
});
