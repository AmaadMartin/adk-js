/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment simulation
 *
 * `getTicket` below throws if it is ever called, because there is no ticketing
 * system to call. `EnvironmentSimulationFactory.createCallback` answers the
 * call instead: `T-404` gets a 404 error, and every other id gets a canned
 * ticket. Ask the agent about a ticket and the answer comes from the
 * simulation, with the real function body never running.
 *
 * Run (needs a model API key, like the other model-backed samples):
 *   npm run sample -- samples/tools/environment_simulation/agent.ts
 */

import {
  EnvironmentSimulationFactory,
  FunctionTool,
  LlmAgent,
  createEnvironmentSimulationConfig,
} from '@google/adk';
import {Type} from '@google/genai';

const getTicket = new FunctionTool({
  name: 'getTicket',
  description: 'Reads one support ticket by its id.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      ticketId: {type: Type.STRING, description: 'The id of the ticket.'},
    },
    required: ['ticketId'],
  },
  execute: async () => {
    throw new Error(
      'No ticketing system is configured, so getTicket cannot run. The' +
        ' environment simulation should have answered this call.',
    );
  },
});

const simulation = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    {
      toolName: 'getTicket',
      injectionConfigs: [
        // The first matching rule wins, so the 404 case comes first.
        {
          matchArgs: {ticketId: 'T-404'},
          injectedError: {
            injectedHttpErrorCode: 404,
            errorMessage: 'no such ticket',
          },
        },
        {
          injectedResponse: {
            ticketId: 'T-1',
            status: 'open',
            subject: 'Printer is offline',
          },
        },
      ],
    },
  ],
});

export const rootAgent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'You answer questions about support tickets. Always call getTicket to' +
    ' look a ticket up, and report what it returns, including any error.',
  tools: [getTicket],
  beforeToolCallback: EnvironmentSimulationFactory.createCallback(simulation),
});
