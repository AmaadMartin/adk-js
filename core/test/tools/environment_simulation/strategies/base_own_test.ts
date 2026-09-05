/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-python has no `test_base.py` for
 * `tools/environment_simulation/strategies/base.py`, so 0 of 0 reference tests
 * are ported. Every test here is adk-js's own.
 */

import {
  BaseMockStrategy,
  Context,
  FeatureName,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  MockRequest,
  NotImplementedError,
  PluginManager,
  ToolConnectionMap,
  TracingMockStrategy,
  createSession,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

function makeToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

function makeTool(): FunctionTool {
  return new FunctionTool({
    name: 'get_weather',
    description: 'Reports the weather.',
    parameters: z.object({city: z.string()}),
    execute: () => 'sunny',
  });
}

const TOOL_CONNECTION_MAP: ToolConnectionMap = {
  statefulParameters: [
    {
      parameterName: 'ticket_id',
      creatingTools: ['create_ticket'],
      consumingTools: ['close_ticket'],
    },
  ],
};

function makeRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    tool: makeTool(),
    args: {city: 'Zurich'},
    toolContext: makeToolContext(),
    stateStore: {},
    ...overrides,
  };
}

/** Reads every `MockRequest` field back out, so none is merely declared. */
class EchoStrategy extends BaseMockStrategy {
  override async mock(request: MockRequest): Promise<Record<string, unknown>> {
    return {
      toolName: request.tool.name,
      args: request.args,
      toolContext: request.toolContext,
      toolConnectionMap: request.toolConnectionMap,
      stateStore: request.stateStore,
      environmentData: request.environmentData,
      tracing: request.tracing,
    };
  }
}

function withEnvironmentSimulation<T>(callback: () => Promise<T> | T) {
  return withTemporaryFeatureOverride(
    FeatureName.ENVIRONMENT_SIMULATION,
    true,
    callback,
  );
}

describe('BaseMockStrategy', () => {
  it('refuses to construct while ENVIRONMENT_SIMULATION is disabled', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.ENVIRONMENT_SIMULATION,
      false,
      () => {
        expect(() => new BaseMockStrategy()).toThrowError(
          'Feature ENVIRONMENT_SIMULATION is not enabled.',
        );
      },
    );
  });

  it('rejects with NotImplementedError when mock() is not overridden', async () => {
    await withEnvironmentSimulation(async () => {
      const strategy = new BaseMockStrategy();

      await expect(strategy.mock(makeRequest())).rejects.toThrowError(
        NotImplementedError,
      );
      await expect(strategy.mock(makeRequest())).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error && error.name === 'NotImplementedError',
      );
    });
  });

  it('calls a subclass override instead of throwing', async () => {
    await withEnvironmentSimulation(async () => {
      const result = await new EchoStrategy().mock(
        makeRequest({args: {city: 'Oslo'}}),
      );

      expect(result.toolName).toBe('get_weather');
      expect(result.args).toEqual({city: 'Oslo'});
    });
  });

  it('passes every MockRequest field through to the subclass', async () => {
    await withEnvironmentSimulation(async () => {
      const stateStore = {ticket_id: 'T-1'};
      const toolContext = makeToolContext();

      const result = await new EchoStrategy().mock(
        makeRequest({
          toolContext,
          toolConnectionMap: TOOL_CONNECTION_MAP,
          stateStore,
          environmentData: 'a support desk',
          tracing: 'create_ticket -> close_ticket',
        }),
      );

      expect(result.toolContext).toBe(toolContext);
      expect(result.toolConnectionMap).toEqual(TOOL_CONNECTION_MAP);
      expect(result.stateStore).toBe(stateStore);
      expect(result.environmentData).toBe('a support desk');
      expect(result.tracing).toBe('create_ticket -> close_ticket');
    });
  });
});

describe('TracingMockStrategy', () => {
  it('refuses to construct while ENVIRONMENT_SIMULATION is disabled', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.ENVIRONMENT_SIMULATION,
      false,
      () => {
        expect(() => new TracingMockStrategy()).toThrowError(
          'Feature ENVIRONMENT_SIMULATION is not enabled.',
        );
      },
    );
  });

  it('answers every call with the fixed not-implemented response', async () => {
    await withEnvironmentSimulation(async () => {
      const response = await new TracingMockStrategy().mock(makeRequest());

      expect(response).toEqual({
        status: 'error',
        errorMessage: 'Not implemented',
      });
    });
  });

  it('defaults llmName to the empty string and leaves llmConfig unset', async () => {
    await withEnvironmentSimulation(() => {
      const strategy = new TracingMockStrategy();

      expect(strategy.llmName).toBe('');
      expect(strategy.llmConfig).toBeUndefined();
    });
  });

  it('keeps the model and config it was constructed with', async () => {
    await withEnvironmentSimulation(() => {
      const strategy = new TracingMockStrategy('gemini-2.5-flash', {
        temperature: 0.2,
      });

      expect(strategy.llmName).toBe('gemini-2.5-flash');
      expect(strategy.llmConfig).toEqual({temperature: 0.2});
    });
  });

  it('is a BaseMockStrategy', async () => {
    await withEnvironmentSimulation(() => {
      expect(new TracingMockStrategy()).toBeInstanceOf(BaseMockStrategy);
    });
  });
});
