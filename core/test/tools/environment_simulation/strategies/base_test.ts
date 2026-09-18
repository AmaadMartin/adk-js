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
  BaseTool,
  Context,
  FeatureName,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  MockRequest,
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

function makeTool(name = 'get_weather'): BaseTool {
  return new FunctionTool({
    name,
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

/** The stateStore example from the developer guide, run as written. */
class TicketStrategy extends BaseMockStrategy {
  override async mock(request: MockRequest): Promise<Record<string, unknown>> {
    if (request.tool.name === 'create_ticket') {
      request.stateStore['ticket_id'] = 'T-1';
      return {status: 'ok', ticketId: 'T-1'};
    }
    const ticketId = request.stateStore['ticket_id'];
    if (ticketId === undefined) {
      return {status: 'error', errorMessage: 'no ticket has been created'};
    }
    return {status: 'ok', ticketId};
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
  it('refuses to construct a subclass while ENVIRONMENT_SIMULATION is disabled', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.ENVIRONMENT_SIMULATION,
      false,
      () => {
        expect(() => new EchoStrategy()).toThrowError(
          'Feature ENVIRONMENT_SIMULATION is not enabled.',
        );
      },
    );
  });

  it('calls the subclass implementation of mock()', async () => {
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

  it('carries a creating call to a consuming call through stateStore', async () => {
    await withEnvironmentSimulation(async () => {
      const strategy = new TicketStrategy();
      const stateStore: Record<string, unknown> = {};

      const created = await strategy.mock(
        makeRequest({tool: makeTool('create_ticket'), stateStore}),
      );
      const closed = await strategy.mock(
        makeRequest({tool: makeTool('close_ticket'), stateStore}),
      );

      expect(created).toEqual({status: 'ok', ticketId: 'T-1'});
      expect(stateStore).toEqual({ticket_id: 'T-1'});
      expect(closed).toEqual({status: 'ok', ticketId: 'T-1'});
    });
  });

  it('reports an error when the consuming call finds no stored state', async () => {
    await withEnvironmentSimulation(async () => {
      const result = await new TicketStrategy().mock(
        makeRequest({tool: makeTool('close_ticket'), stateStore: {}}),
      );

      expect(result).toEqual({
        status: 'error',
        errorMessage: 'no ticket has been created',
      });
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
