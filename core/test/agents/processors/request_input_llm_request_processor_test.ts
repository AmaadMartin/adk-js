/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The node-tool resume path: a typed reply to a paused node-tool is recorded in
 * the session as the `functionResponse` an interactive client would have sent,
 * and only the current turn's reply is read.
 */

import {
  createEvent,
  createSession,
  Event,
  getFunctionResponses,
  InvocationContext,
  LlmAgent,
  node,
  PluginManager,
  RequestInput,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';
import {
  createRequestInputEvent,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../../src/workflow/utils/hitl_utils.js';

vi.mock('../../../src/agents/functions.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/agents/functions.js')>();
  return {
    ...original,
    handleFunctionCallList: vi.fn().mockResolvedValue(null),
  };
});

/** The node-tool the agent exposes, and the node behind it. */
const TOOL_NAME = 'gate';

/** The id of the node-tool call the model left pending while the node paused. */
const TOOL_CALL_ID = 'call-1';

/** An agent with one node-tool: what makes this processor engage at all. */
function gateAgent(): LlmAgent {
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

/** The model turn calling the node-tool, left unanswered while it pauses. */
function nodeToolCall(): Event {
  return createEvent({
    author: 'gate_agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id: TOOL_CALL_ID, name: TOOL_NAME, args: {}}}],
    },
  });
}

/** An `adk_request_input` interrupt raised inside the node-tool. */
function interrupt(interruptId: string): Event {
  return createRequestInputEvent(new RequestInput({interruptId}));
}

/** The node-tool's own function response, ending the pending call. */
function nodeToolResponse(): Event {
  return createEvent({
    author: 'gate_agent',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: TOOL_CALL_ID,
            name: TOOL_NAME,
            response: {result: 'done'},
          },
        },
      ],
    },
  });
}

/** A user turn that types a reply. */
function userText(text: string): Event {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

/** A user turn that answers an interrupt with a structured reply. */
function userStructured(interruptId: string, value: string): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: interruptId,
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            response: {result: value},
          },
        },
      ],
    },
  });
}

/** Runs the processor over `events` and returns the events it yielded. */
async function runProcessor(events: Event[]): Promise<Event[]> {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-current',
    branch: 'gate_agent',
    agent: gateAgent(),
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
  return yielded;
}

/** The resume inputs the processor threaded to the re-run node-tool. */
async function threadedResumeInputs(): Promise<Record<string, unknown>> {
  const {handleFunctionCallList} =
    await import('../../../src/agents/functions.js');
  const call = vi.mocked(handleFunctionCallList).mock.calls.at(-1);
  if (!call) {
    expect.fail('the processor never re-ran the pending node-tool');
  }
  return call[0].toolConfirmationDict?.[TOOL_CALL_ID].payload as Record<
    string,
    unknown
  >;
}

describe('RequestInputLlmRequestProcessor — plain-text resume record', () => {
  it('records the typed reply before re-running the node-tool', async () => {
    const yielded = await runProcessor([
      nodeToolCall(),
      interrupt('A'),
      userText('approve'),
    ]);

    expect(yielded).toHaveLength(1);
    expect(yielded[0].author).toBe('user');
    expect(getFunctionResponses(yielded[0])).toEqual([
      {
        id: 'A',
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {result: 'approve'},
      },
    ]);
    expect(await threadedResumeInputs()).toEqual({A: 'approve'});
  });

  it('carries the current invocation and branch on the record', async () => {
    const yielded = await runProcessor([
      nodeToolCall(),
      interrupt('A'),
      userText('approve'),
    ]);

    expect(yielded).toHaveLength(1);
    expect(yielded[0].invocationId).toBe('inv-current');
    expect(yielded[0].branch).toBe('gate_agent');
  });

  it('threads the value a replay of the record recovers', async () => {
    await runProcessor([nodeToolCall(), interrupt('A'), userText('42')]);

    // `42` is the number the equivalent client reply `{result: "42"}` unwraps
    // to, so the live turn and a later replay agree.
    expect(await threadedResumeInputs()).toEqual({A: 42});
  });

  it('records nothing for a structured reply, which is already recorded', async () => {
    const yielded = await runProcessor([
      nodeToolCall(),
      interrupt('A'),
      userStructured('A', 'approve'),
    ]);

    expect(yielded).toEqual([]);
    expect(await threadedResumeInputs()).toEqual({A: 'approve'});
  });

  it('answers the second pause from the second typed reply', async () => {
    const yielded = await runProcessor([
      nodeToolCall(),
      interrupt('A'),
      userText('first answer'),
      // The record turn 2 left behind, which turn 3 must not read as a reply.
      userStructured('A', 'first answer'),
      interrupt('B'),
      userText('second answer'),
    ]);

    expect(await threadedResumeInputs()).toEqual({B: 'second answer'});
    expect(yielded).toHaveLength(1);
    expect(getFunctionResponses(yielded[0])).toEqual([
      {
        id: 'B',
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {result: 'second answer'},
      },
    ]);
  });

  it('records nothing when no interrupt is pending', async () => {
    expect(await runProcessor([nodeToolCall(), userText('hello')])).toEqual([]);
  });

  it('records nothing when the turn that paused has no user event', async () => {
    expect(await runProcessor([nodeToolCall(), interrupt('A')])).toEqual([]);
  });

  it('records nothing for a reply that is not plain text', async () => {
    const image = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{inlineData: {mimeType: 'image/png', data: 'aGk='}}],
      },
    });

    expect(await runProcessor([nodeToolCall(), interrupt('A'), image])).toEqual(
      [],
    );
  });

  it('ignores a user function response that answers no interrupt', async () => {
    const foreign = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          // Not an interrupt reply: another tool's response, and an
          // `adk_request_input` response that names no interrupt.
          {functionResponse: {id: 'x', name: 'other_tool', response: {}}},
          {
            functionResponse: {
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              response: {result: 'approve'},
            },
          },
        ],
      },
    });

    expect(
      await runProcessor([nodeToolCall(), interrupt('A'), foreign]),
    ).toEqual([]);
  });

  it('records nothing when the node-tool call is already answered', async () => {
    expect(
      await runProcessor([
        nodeToolCall(),
        interrupt('A'),
        nodeToolResponse(),
        userText('approve'),
      ]),
    ).toEqual([]);
  });

  it('records nothing when the agent has no node-tool', async () => {
    const invocationContext = new InvocationContext({
      invocationId: 'inv-current',
      agent: new LlmAgent({name: 'plain_agent', model: 'gemini-2.5-flash'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        events: [nodeToolCall(), interrupt('A'), userText('approve')],
      }),
      pluginManager: new PluginManager([]),
    });

    const yielded: Event[] = [];
    for await (const event of REQUEST_INPUT_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
    )) {
      yielded.push(event);
    }

    expect(yielded).toEqual([]);
  });

  it('rejects a structured reply that violates its declared schema', async () => {
    const raise = createRequestInputEvent(
      new RequestInput({
        interruptId: 'A',
        responseSchema: z.object({approved: z.boolean()}),
      }),
    );

    await expect(
      runProcessor([
        nodeToolCall(),
        raise,
        userStructured('A', '{"approved":"yes"}'),
      ]),
    ).rejects.toThrow(/reply to interrupt 'A' does not match/i);
  });
});
