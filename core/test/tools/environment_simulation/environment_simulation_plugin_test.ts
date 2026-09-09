/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  EnvironmentSimulationPlugin,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {
  createToolContext,
  FakeTool,
  resetScriptedModel,
  SCRIPTED_MODEL,
} from './simulation_test_utils.js';

const INJECTED_RESPONSE = {ticket_id: 'T-42', status: 'open'};

function createPlugin(): EnvironmentSimulationPlugin {
  return new EnvironmentSimulationPlugin({
    toolSimulationConfigs: [
      {
        toolName: 'create_ticket',
        injectionConfigs: [{injectedResponse: INJECTED_RESPONSE}],
      },
    ],
    simulationModel: SCRIPTED_MODEL,
    simulationModelConfiguration: {},
  });
}

/** A model that calls `create_ticket` once, then reports what came back. */
class TicketCallingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor() {
    super({model: 'ticket-calling-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'create_ticket',
                args: {title: 'printer on fire'},
              },
            },
          ],
        },
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'Ticket created.'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('TicketCallingLlm does not support live connections.');
  }
}

describe('EnvironmentSimulationPlugin', () => {
  beforeEach(() => {
    resetScriptedModel();
  });

  it('registers under a stable name a PluginManager accepts', () => {
    const plugin = createPlugin();

    expect(plugin.name).toBe('environment_simulation');
    expect(new PluginManager([plugin]).getPlugin(plugin.name)).toBe(plugin);
  });

  it('forwards the call to the engine and returns its answer', async () => {
    const plugin = createPlugin();

    const result = await plugin.beforeToolCallback({
      tool: new FakeTool('create_ticket'),
      toolArgs: {title: 'printer on fire'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual(INJECTED_RESPONSE);
  });

  it('lets an unconfigured tool run', async () => {
    const plugin = createPlugin();

    const result = await plugin.beforeToolCallback({
      tool: new FakeTool('delete_ticket'),
      toolArgs: {},
      toolContext: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('rejects an invalid config as it is constructed', () => {
    expect(
      () => new EnvironmentSimulationPlugin({toolSimulationConfigs: []}),
    ).toThrowError('toolSimulationConfigs must be provided.');
  });
});

describe('EnvironmentSimulationPlugin on a runner', () => {
  it('answers the tool call from the simulation and never runs the tool', async () => {
    let toolRan = false;
    const createTicket = new FunctionTool({
      name: 'create_ticket',
      description: 'Opens a support ticket.',
      parameters: z.object({title: z.string()}),
      execute: async () => {
        toolRan = true;
        throw new Error('The real create_ticket must never run.');
      },
    });
    const model = new TicketCallingLlm();
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'support',
        model,
        tools: [createTicket],
      }),
      plugins: [createPlugin()],
    });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'test_user',
    });

    for await (const _event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'open a ticket'}]},
    })) {
      // Drain the run so the tool call completes.
    }

    expect(toolRan).toBe(false);
    const functionResponses = model.requests[1].contents.flatMap(
      (content) =>
        content.parts?.flatMap((part) =>
          part.functionResponse ? [part.functionResponse] : [],
        ) ?? [],
    );
    expect(functionResponses).toHaveLength(1);
    expect(functionResponses[0].response).toEqual(INJECTED_RESPONSE);
  });
});
