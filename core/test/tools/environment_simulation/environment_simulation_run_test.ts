/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a real `InMemoryRunner`, a real `LlmAgent` and a real `FunctionTool`
 * through both ways of attaching an environment simulation.
 *
 * Nothing in the simulation is stubbed. The agent's model is a fake, because a
 * real one needs credentials, and the tool throws if the framework ever runs
 * it — which is what proves the simulation answered in its place.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
  EnvironmentSimulationFactory,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  MockStrategy,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'environment_simulation_run_test';
const USER_ID = 'user_1';

/** A model that asks for `getTicket` once, then answers in text. */
class GetTicketLlm extends BaseLlm {
  private calls = 0;

  constructor() {
    super({model: 'get-ticket-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'getTicket',
                args: {ticketId: 'missing'},
                id: 'call_1',
              },
            },
          ],
        },
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

function uncallableGetTicket(): FunctionTool {
  return new FunctionTool({
    name: 'getTicket',
    description: 'Reads a ticket from the real ticketing system.',
    execute: async () => {
      throw new Error('The real getTicket tool ran.');
    },
  });
}

function notFoundConfig() {
  return createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: 'getTicket',
        injectionConfigs: [
          createInjectionConfig({
            matchArgs: {ticketId: 'missing'},
            injectedError: {
              injectedHttpErrorCode: 404,
              errorMessage: 'no such ticket',
            },
          }),
        ],
        mockStrategyType: MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
      }),
    ],
  });
}

/** Every tool response the run produced, in order. */
function toolResponses(events: Event[]): unknown[] {
  const responses: unknown[] = [];
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse) {
        responses.push(part.functionResponse.response);
      }
    }
  }
  return responses;
}

async function runOnce(runner: InMemoryRunner): Promise<Event[]> {
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage: {parts: [{text: 'read ticket missing'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('environment simulation in a real agent run', () => {
  it('answers the tool call from the before-tool callback', async () => {
    const events = await runOnce(
      new InMemoryRunner({
        appName: APP_NAME,
        agent: new LlmAgent({
          name: 'support',
          model: new GetTicketLlm(),
          tools: [uncallableGetTicket()],
          beforeToolCallback:
            EnvironmentSimulationFactory.createCallback(notFoundConfig()),
        }),
      }),
    );

    expect(toolResponses(events)).toEqual([
      {errorCode: 404, errorMessage: 'no such ticket'},
    ]);
  });

  it('answers the tool call from the plugin', async () => {
    const events = await runOnce(
      new InMemoryRunner({
        appName: APP_NAME,
        agent: new LlmAgent({
          name: 'support',
          model: new GetTicketLlm(),
          tools: [uncallableGetTicket()],
        }),
        plugins: [EnvironmentSimulationFactory.createPlugin(notFoundConfig())],
      }),
    );

    expect(toolResponses(events)).toEqual([
      {errorCode: 404, errorMessage: 'no such ticket'},
    ]);
  });

  it('runs the real tool when the simulation does not answer', async () => {
    const events = await runOnce(
      new InMemoryRunner({
        appName: APP_NAME,
        agent: new LlmAgent({
          name: 'support',
          model: new GetTicketLlm(),
          tools: [uncallableGetTicket()],
          beforeToolCallback: EnvironmentSimulationFactory.createCallback(
            createEnvironmentSimulationConfig({
              toolSimulationConfigs: [
                createToolSimulationConfig({
                  toolName: 'someOtherTool',
                  injectionConfigs: [
                    createInjectionConfig({injectedResponse: {injected: true}}),
                  ],
                }),
              ],
            }),
          ),
        }),
      }),
    );

    expect(JSON.stringify(toolResponses(events))).toContain(
      'The real getTicket tool ran.',
    );
  });
});
