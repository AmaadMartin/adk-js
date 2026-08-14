/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {
  createEvent,
  createSession,
  InvocationContext,
  LlmAgent,
  node,
  PluginManager,
  RequestInput,
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
    handleFunctionCallList: vi.fn(async () => null),
  };
});

/** The node-tool the agent exposes, and the node behind it. */
const TOOL_NAME = 'gate';

/** The invocation the processor runs in: the turn carrying the reply. */
const CURRENT_INVOCATION = 'inv-current';

/** An agent with one node-tool, which is what makes this processor engage. */
function agentWithNodeTool(): LlmAgent {
  return new LlmAgent({
    name: 'gate_agent',
    model: 'gemini-2.5-flash',
    tools: [
      node(() => 'done', {
        name: TOOL_NAME,
        inputSchema: z.object({which: z.string()}),
        rerunOnResume: true,
      }),
    ],
  });
}

/** A model turn calling the node-tool, left unanswered while the node pauses. */
function nodeToolCall(invocationId: string, callId: string): Event {
  return createEvent({
    invocationId,
    author: 'gate_agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id: callId, name: TOOL_NAME, args: {}}}],
    },
  });
}

/**
 * An `adk_request_input` interrupt as the engine mints it: stamped with the
 * node's path, and carrying no invocation id of its own.
 */
function interrupt(interruptId: string, responseSchema?: SchemaLike): Event {
  return {
    ...createRequestInputEvent(
      new RequestInput({
        interruptId,
        message: `${interruptId}?`,
        responseSchema,
      }),
    ),
    author: TOOL_NAME,
    nodeInfo: {path: TOOL_NAME},
  };
}

/** A user turn replying with plain text. */
function userText(invocationId: string, text: string): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

/**
 * Runs the processor over `events` and returns the mocked
 * `handleFunctionCallList` spy plus the events the processor yielded.
 */
async function runProcessor(events: Event[]) {
  const {handleFunctionCallList} =
    await import('../../../src/agents/functions.js');
  const spy = vi.mocked(handleFunctionCallList);
  spy.mockClear();

  const invocationContext = new InvocationContext({
    invocationId: CURRENT_INVOCATION,
    agent: agentWithNodeTool(),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager([]),
  });

  const yielded: Event[] = [];
  for await (const event of REQUEST_INPUT_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    yielded.push(event);
  }
  return {spy, yielded};
}

/** The resume inputs the processor threaded into `callId`'s confirmation. */
function payloadFor(
  spy: Awaited<ReturnType<typeof runProcessor>>['spy'],
  callId: string,
): unknown {
  const call = spy.mock.calls[0]?.[0];
  if (!call?.toolConfirmationDict) {
    expect.fail('the processor did not re-run the pending node-tool');
  }
  return call.toolConfirmationDict[callId].payload;
}

describe('RequestInputLlmRequestProcessor — plain-text resume', () => {
  it('hands the text to the one interrupt that is pending', async () => {
    const {spy} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION, 'call-1'),
      interrupt('gate_a'),
      userText(CURRENT_INVOCATION, 'yes'),
    ]);

    expect(payloadFor(spy, 'call-1')).toEqual({gate_a: 'yes'});
  });

  it('resolves nothing when two interrupts are pending', async () => {
    const {spy, yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION, 'call-1'),
      interrupt('gate_a'),
      interrupt('gate_b'),
      userText(CURRENT_INVOCATION, 'yes'),
    ]);

    expect(spy).not.toHaveBeenCalled();
    expect(yielded).toHaveLength(0);
  });

  it('resolves nothing when the reply is not plain text', async () => {
    const {spy, yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION, 'call-1'),
      interrupt('gate_a'),
      createEvent({
        invocationId: CURRENT_INVOCATION,
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'other-1',
                name: 'some_other_tool',
                response: {result: 'yes'},
              },
            },
          ],
        },
      }),
    ]);

    expect(spy).not.toHaveBeenCalled();
    expect(yielded).toHaveLength(0);
  });

  it('resumes a second pause after an earlier one was answered by typing', async () => {
    // A plain-text reply leaves no functionResponse behind, so `gate_a` is
    // still unanswered in the session even though its node-tool call returned.
    const {spy} = await runProcessor([
      userText('inv-1', 'start'),
      nodeToolCall('inv-1', 'call-1'),
      interrupt('gate_a'),
      userText('inv-2', 'yes'),
      createEvent({
        invocationId: 'inv-2',
        author: TOOL_NAME,
        content: {role: 'model', parts: [{text: 'resolved gate_a=yes'}]},
        output: 'resolved gate_a=yes',
        nodeInfo: {path: TOOL_NAME},
      }),
      createEvent({
        invocationId: 'inv-2',
        author: 'gate_agent',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: TOOL_NAME,
                response: {result: 'resolved gate_a=yes'},
              },
            },
          ],
        },
      }),
      nodeToolCall('inv-2', 'call-2'),
      interrupt('gate_b'),
      userText(CURRENT_INVOCATION, 'sure'),
    ]);

    expect(payloadFor(spy, 'call-2')).toEqual({gate_b: 'sure'});
  });
});

describe('RequestInputLlmRequestProcessor — plain-text resume held to the declared schema', () => {
  /**
   * Runs the processor over a session paused on one interrupt that declared
   * `responseSchema`, and returns the resume inputs the reply produced.
   */
  async function resumeInputsFor(
    replies: Event[],
    responseSchema?: SchemaLike,
  ): Promise<unknown> {
    const {spy} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION, 'call-1'),
      interrupt('gate_a', responseSchema),
      ...replies,
    ]);
    return payloadFor(spy, 'call-1');
  }

  it('delivers a number to an interrupt that asked for one', async () => {
    expect(
      await resumeInputsFor([userText(CURRENT_INVOCATION, '42')], z.number()),
    ).toEqual({gate_a: 42});
  });

  it('fails the turn when the reply cannot be that number', async () => {
    await expect(
      resumeInputsFor([userText(CURRENT_INVOCATION, 'abc')], z.number()),
    ).rejects.toThrow(/reply to interrupt 'gate_a' does not match/i);
  });

  it('stores the text as typed when the interrupt declared no schema', async () => {
    expect(
      await resumeInputsFor([userText(CURRENT_INVOCATION, 'abc')]),
    ).toEqual({gate_a: 'abc'});
  });

  it('stores the text as typed for an object schema', async () => {
    const schema = z.object({approved: z.boolean()});
    expect(
      await resumeInputsFor([userText(CURRENT_INVOCATION, 'yes')], schema),
    ).toEqual({gate_a: 'yes'});
  });

  it('prefers a structured reply over the plain-text fallback', async () => {
    // The trailing 'abc' turn would throw if the fallback ran, so this pins the
    // precedence as well as the value.
    const structured = createEvent({
      invocationId: CURRENT_INVOCATION,
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'gate_a',
              name: 'adk_request_input',
              response: {result: 7},
            },
          },
        ],
      },
    });
    expect(
      await resumeInputsFor(
        [structured, userText(CURRENT_INVOCATION, 'abc')],
        z.number(),
      ),
    ).toEqual({gate_a: 7});
  });
});
