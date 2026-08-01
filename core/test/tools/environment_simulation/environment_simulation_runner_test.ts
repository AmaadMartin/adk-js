/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  EnvironmentSimulationFactory,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  MockStrategy,
  Runner,
  getFunctionResponses,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/** A model that replays a scripted turn per call. */
class ScriptedLlm extends BaseLlm {
  private call = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const response = this.responses[this.call++];
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not supported by ScriptedLlm.');
  }
}

const CHARGE_CARD_CALL: LlmResponse = {
  content: {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'charge_card',
          args: {amount: 9999},
          id: 'call_1',
        },
      },
    ],
  },
};
const FINAL_ANSWER: LlmResponse = {
  content: {role: 'model', parts: [{text: 'The payment provider is down.'}]},
};

async function runTurn(plugins: BasePlugin[]): Promise<{
  events: Event[];
  chargedAmounts: number[];
}> {
  const chargedAmounts: number[] = [];
  const chargeCard = new FunctionTool({
    name: 'charge_card',
    description: 'Charges the customer card.',
    parameters: z.object({amount: z.number()}),
    execute: ({amount}) => {
      chargedAmounts.push(amount);
      return {status: 'charged'};
    },
  });

  const agent = new LlmAgent({
    name: 'billing_agent',
    model: new ScriptedLlm([CHARGE_CARD_CALL, FINAL_ANSWER]),
    tools: [chargeCard],
  });

  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'user_1',
  });
  const runner = new Runner({
    appName: 'test_app',
    agent,
    sessionService,
    plugins,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user_1',
    sessionId: session.id,
    newMessage: {parts: [{text: 'Charge my card 9999'}]},
  })) {
    events.push(event);
  }
  return {events, chargedAmounts};
}

function toolResponses(events: Event[]): unknown[] {
  return events.flatMap((event) =>
    getFunctionResponses(event).map((response) => response.response),
  );
}

describe('environment simulation through a Runner', () => {
  it('runs the real tool when no simulation plugin is installed', async () => {
    const {chargedAmounts, events} = await runTurn([]);

    expect(chargedAmounts).toEqual([9999]);
    expect(toolResponses(events)).toEqual([{status: 'charged'}]);
  });

  it('returns the injected error and never charges the card', async () => {
    const plugin = EnvironmentSimulationFactory.createPlugin({
      toolSimulationConfigs: [
        {
          toolName: 'charge_card',
          injectionConfigs: [
            {
              matchArgs: {amount: 9999},
              injectedError: {
                injectedHttpErrorCode: 503,
                errorMessage: 'upstream down',
              },
            },
          ],
        },
      ],
    });

    const {chargedAmounts, events} = await runTurn([plugin]);

    expect(chargedAmounts).toEqual([]);
    expect(toolResponses(events)).toEqual([
      {error_code: 503, error_message: 'upstream down'},
    ]);
  });

  it('runs the real tool for an argument the injection does not match', async () => {
    const plugin = EnvironmentSimulationFactory.createPlugin({
      toolSimulationConfigs: [
        {
          toolName: 'charge_card',
          injectionConfigs: [
            {
              matchArgs: {amount: 1},
              injectedError: {
                injectedHttpErrorCode: 503,
                errorMessage: 'upstream down',
              },
            },
          ],
        },
      ],
    });

    const {chargedAmounts, events} = await runTurn([plugin]);

    expect(chargedAmounts).toEqual([9999]);
    expect(toolResponses(events)).toEqual([{status: 'charged'}]);
  });

  it('leaves a tool that is not configured for simulation alone', async () => {
    const plugin = EnvironmentSimulationFactory.createPlugin({
      toolSimulationConfigs: [
        {
          toolName: 'refund_card',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });

    const {chargedAmounts, events} = await runTurn([plugin]);

    expect(chargedAmounts).toEqual([9999]);
    expect(toolResponses(events)).toEqual([{status: 'charged'}]);
  });
});
