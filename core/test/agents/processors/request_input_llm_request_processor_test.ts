/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  node,
  PluginManager,
  RequestInput,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';
import type {SchemaLike} from '../../../src/utils/schema.js';
import {createRequestInputEvent} from '../../../src/workflow/utils/hitl_utils.js';

vi.mock('../../../src/agents/functions.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/agents/functions.js')>();
  return {
    ...original,
    handleFunctionCallList: vi.fn().mockResolvedValue(null),
  };
});

/** The id of the node-tool call left pending by the pause. */
const TOOL_CALL_ID = 'call-1';
/** The id of the interrupt the paused node raised. */
const INTERRUPT_ID = 'gate';

/** An agent with one node-tool, which is what this processor resumes. */
function agentWithNodeTool(): LlmAgent {
  return new LlmAgent({
    name: 'test_agent',
    model: 'gemini-2.5-flash',
    tools: [node(() => 'done', {name: 'ask', inputSchema: z.string()})],
  });
}

/** The model turn that called the node-tool, left unanswered by the pause. */
function nodeToolCallEvent(): Event {
  return createEvent({
    invocationId: 'test-invocation',
    author: 'test_agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id: TOOL_CALL_ID, name: 'ask', args: {}}}],
    },
  });
}

/** A user turn replying with plain text. */
function userTextEvent(text: string): Event {
  return createEvent({
    invocationId: 'test-invocation',
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

/**
 * Runs the processor over a session paused on `INTERRUPT_ID` and returns the
 * resume inputs it threaded into the node-tool's confirmation payload.
 */
async function resumeInputsFor(
  replies: Event[],
  responseSchema?: SchemaLike,
): Promise<Record<string, unknown>> {
  const {handleFunctionCallList} =
    await import('../../../src/agents/functions.js');
  const spy = vi.mocked(handleFunctionCallList);
  spy.mockClear();

  const interrupt = createRequestInputEvent(
    new RequestInput({
      interruptId: INTERRUPT_ID,
      message: 'how old?',
      responseSchema,
    }),
  );
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: agentWithNodeTool(),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events: [nodeToolCallEvent(), interrupt, ...replies],
    }),
    pluginManager: new PluginManager([]),
  });

  for await (const _ of REQUEST_INPUT_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    void _;
  }

  const call = spy.mock.calls[0]?.[0];
  if (!call?.toolConfirmationDict) {
    expect.fail('the processor did not re-run the pending node-tool');
  }
  const confirmation: ToolConfirmation =
    call.toolConfirmationDict[TOOL_CALL_ID];
  return confirmation.payload as Record<string, unknown>;
}

describe('RequestInputLlmRequestProcessor — plain-text resume', () => {
  it('delivers a number to an interrupt that asked for one', async () => {
    expect(await resumeInputsFor([userTextEvent('42')], z.number())).toEqual({
      [INTERRUPT_ID]: 42,
    });
  });

  it('fails the turn when the reply cannot be that number', async () => {
    await expect(
      resumeInputsFor([userTextEvent('abc')], z.number()),
    ).rejects.toThrow(/reply to interrupt 'gate' does not match/i);
  });

  it('stores the text as typed when the interrupt declared no schema', async () => {
    expect(await resumeInputsFor([userTextEvent('abc')])).toEqual({
      [INTERRUPT_ID]: 'abc',
    });
  });

  it('stores the text as typed for an object schema', async () => {
    const schema = z.object({approved: z.boolean()});
    expect(await resumeInputsFor([userTextEvent('yes')], schema)).toEqual({
      [INTERRUPT_ID]: 'yes',
    });
  });

  it('prefers a structured reply over the plain-text fallback', async () => {
    // The trailing 'abc' turn would throw if the fallback ran, so this pins the
    // precedence as well as the value.
    const structured = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: INTERRUPT_ID,
              name: 'adk_request_input',
              response: {result: 7},
            },
          },
        ],
      },
    });
    expect(
      await resumeInputsFor([structured, userTextEvent('abc')], z.number()),
    ).toEqual({
      [INTERRUPT_ID]: 7,
    });
  });
});
