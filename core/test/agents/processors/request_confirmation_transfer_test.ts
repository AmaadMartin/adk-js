/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  createEvent,
  createSession,
  getFunctionResponses,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';

const REJECTION_ERROR = 'Tool call rejected from confirmation flow.';

/**
 * Blocks a tool call the user denied, mirroring the gate `SecurityPlugin`
 * applies. The core flow has no rejection gate of its own, so a plugin has to
 * supply one for the denied path to be denied.
 */
class RejectUnconfirmedPlugin extends BasePlugin {
  constructor() {
    super('reject_unconfirmed');
  }

  override async beforeToolCallback({
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    if (toolContext.toolConfirmation?.confirmed === false) {
      return {error: REJECTION_ERROR};
    }
    return;
  }
}

/**
 * Builds a session history where the model asked to transfer to `sub_agent`,
 * the flow gated the call behind a confirmation, and the user answered it.
 */
function createTransferConfirmationEvents(confirmed: boolean): Event[] {
  const confirmationCallEvent = createEvent({
    invocationId: 'test-invocation',
    author: 'orchestrator',
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'fc-confirm-transfer',
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            args: {
              originalFunctionCall: {
                id: 'fc-transfer',
                name: 'transfer_to_agent',
                args: {agentName: 'sub_agent'},
              },
            },
          },
        },
      ],
    },
  });

  const userConfirmationEvent = createEvent({
    invocationId: 'test-invocation',
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'fc-confirm-transfer',
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: {confirmed, hint: ''},
          },
        },
      ],
    },
  });

  return [confirmationCallEvent, userConfirmationEvent];
}

function createInvocationContext(
  events: Event[],
  plugins: BasePlugin[] = [],
  subAgents: LlmAgent[] = [
    new LlmAgent({name: 'sub_agent', model: 'gemini-2.5-flash'}),
  ],
): InvocationContext {
  const agent = new LlmAgent({
    name: 'orchestrator',
    model: 'gemini-2.5-flash',
    subAgents,
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events,
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(plugins),
  });
}

async function collectEvents(
  invocationContext: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    events.push(event);
  }
  return events;
}

describe('RequestConfirmationLlmRequestProcessor transfer resume', () => {
  it('should resume an approved transfer_to_agent confirmation', async () => {
    const invocationContext = createInvocationContext(
      createTransferConfirmationEvents(true),
    );

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(1);
    const responses = getFunctionResponses(events[0]);
    expect(responses).toHaveLength(1);
    expect(responses[0].name).toBe('transfer_to_agent');
    expect(responses[0].id).toBe('fc-transfer');
    expect(events[0].actions.transferToAgent).toBe('sub_agent');
  });

  it('should not transfer when the confirmation is rejected', async () => {
    const invocationContext = createInvocationContext(
      createTransferConfirmationEvents(false),
      [new RejectUnconfirmedPlugin()],
    );

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(1);
    const responses = getFunctionResponses(events[0]);
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({error: REJECTION_ERROR});
    expect(events[0].actions.transferToAgent).toBeUndefined();
  });

  // An agent with no targets is never offered `transfer_to_agent`, so the
  // resume keeps the unchanged behaviour rather than registering a tool the
  // agent cannot use. adk-python guards the injection the same way.
  it('should throw for a transfer confirmation when the agent has no transfer targets', async () => {
    const invocationContext = createInvocationContext(
      createTransferConfirmationEvents(true),
      [],
      [],
    );

    await expect(collectEvents(invocationContext)).rejects.toThrow(
      'Function transfer_to_agent is not found in the toolsDict.',
    );
  });
});
