/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseNode,
  Event,
  InvocationContext,
  LlmAgent,
  NodeContext,
  NodeTool,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  SingleOnToolErrorCallback,
  createEvent,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';

const handleFunctionCallList = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
);

vi.mock('../../../src/agents/functions.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/agents/functions.js')>();
  return {...original, handleFunctionCallList};
});

const PENDING_CALL_ID = 'fc_node_tool_1';
const INTERRUPT_ID = 'interrupt_1';

class NoopNode extends BaseNode {
  constructor() {
    super({name: 'noop_node', inputSchema: z.object({})});
  }
  protected async *runImpl(
    _ctx: NodeContext,
    _input: unknown,
  ): AsyncGenerator<Event, void, void> {}
}

/**
 * A session paused on a node-tool call, with the user's answer to the
 * `adk_request_input` interrupt already recorded. This is the state the
 * processor resumes from.
 */
function pausedSessionEvents(): Event[] {
  return [
    createEvent({
      id: 'evt_call',
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: PENDING_CALL_ID, name: 'noop_node', args: {}}},
        ],
      },
    }),
    createEvent({
      id: 'evt_answer',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: INTERRUPT_ID,
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              response: {answer: 'blue'},
            },
          },
        ],
      },
    }),
  ];
}

async function runProcessor(agent: LlmAgent): Promise<void> {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events: pausedSessionEvents(),
    }),
    pluginManager: new PluginManager([]),
  });

  for await (const _event of REQUEST_INPUT_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    // drain
  }
}

describe('RequestInputLlmRequestProcessor onToolErrorCallbacks', () => {
  it("forwards the agent's onToolErrorCallbacks when resuming a node tool", async () => {
    handleFunctionCallList.mockClear();
    const onToolErrorCallback: SingleOnToolErrorCallback = () => ({
      result: 'recovered',
    });
    const agent = new LlmAgent({
      name: 'resume_agent',
      model: 'gemini-2.5-flash',
      tools: [new NodeTool(new NoopNode())],
      onToolErrorCallback,
    });

    await runProcessor(agent);

    expect(handleFunctionCallList).toHaveBeenCalledWith(
      expect.objectContaining({onToolErrorCallbacks: [onToolErrorCallback]}),
    );
  });

  it('forwards an empty list when the agent declares no callback', async () => {
    handleFunctionCallList.mockClear();
    const agent = new LlmAgent({
      name: 'resume_agent',
      model: 'gemini-2.5-flash',
      tools: [new NodeTool(new NoopNode())],
    });

    await runProcessor(agent);

    expect(handleFunctionCallList).toHaveBeenCalledWith(
      expect.objectContaining({onToolErrorCallbacks: []}),
    );
  });
});
