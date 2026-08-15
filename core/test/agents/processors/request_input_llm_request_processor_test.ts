/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The node-tool resume path: a typed reply resumes the single pending
 * interrupt, is held to the scalar schema that interrupt declared, and is
 * recorded in the session as the `functionResponse` an interactive client would
 * have sent. Only the current turn's reply is read.
 */

import type {Event} from '@google/adk';
import {
  createEvent,
  createSession,
  getFunctionResponses,
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
import {
  createRequestInputEvent,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../../src/workflow/utils/hitl_utils.js';

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

/** The id of the node-tool call the model left pending while the node paused. */
const TOOL_CALL_ID = 'call-1';

/** The invocation the processor runs in: the turn carrying the reply. */
const CURRENT_INVOCATION = 'inv-current';

/** The branch the invocation runs on. */
const CURRENT_BRANCH = 'gate_agent';

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
function nodeToolCall(
  invocationId: string,
  callId: string = TOOL_CALL_ID,
): Event {
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

/** The node-tool's own function response, ending the pending call. */
function nodeToolResponse(callId: string = TOOL_CALL_ID): Event {
  return createEvent({
    invocationId: CURRENT_INVOCATION,
    author: 'gate_agent',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: callId,
            name: TOOL_NAME,
            response: {result: 'done'},
          },
        },
      ],
    },
  });
}

/** A user turn replying with plain text. */
function userText(invocationId: string, text: string): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

/** A user turn that answers an interrupt with a structured reply. */
function userStructured(
  invocationId: string,
  interruptId: string,
  value: unknown,
): Event {
  return createEvent({
    invocationId,
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

/**
 * Runs the processor over `events` and returns the mocked
 * `handleFunctionCallList` spy plus the events the processor yielded.
 */
async function runProcessor(
  events: Event[],
  agent: LlmAgent = agentWithNodeTool(),
) {
  const {handleFunctionCallList} =
    await import('../../../src/agents/functions.js');
  const spy = vi.mocked(handleFunctionCallList);
  spy.mockClear();

  const invocationContext = new InvocationContext({
    invocationId: CURRENT_INVOCATION,
    branch: CURRENT_BRANCH,
    agent,
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
    // A session recorded before typed replies left a functionResponse behind:
    // `gate_a` still reads as unanswered even though its node-tool returned.
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
    // Both in one turn: the structured response answers `gate_a`, and the text
    // beside it is never consulted.
    const structuredAndText = createEvent({
      invocationId: CURRENT_INVOCATION,
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'gate_a',
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              response: {result: 7},
            },
          },
          {text: 'abc'},
        ],
      },
    });

    expect(await resumeInputsFor([structuredAndText], z.number())).toEqual({
      gate_a: 7,
    });
  });
});

describe('RequestInputLlmRequestProcessor — plain-text resume record', () => {
  it('records the typed reply before re-running the node-tool', async () => {
    const {spy, yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      userText(CURRENT_INVOCATION, 'approve'),
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
    expect(payloadFor(spy, TOOL_CALL_ID)).toEqual({A: 'approve'});
  });

  it('carries the current invocation and branch on the record', async () => {
    const {yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      userText(CURRENT_INVOCATION, 'approve'),
    ]);

    expect(yielded).toHaveLength(1);
    expect(yielded[0].invocationId).toBe(CURRENT_INVOCATION);
    expect(yielded[0].branch).toBe(CURRENT_BRANCH);
  });

  it('threads the value a replay of the record recovers', async () => {
    const {spy} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      userText(CURRENT_INVOCATION, '42'),
    ]);

    // `42` is the number the equivalent client reply `{result: "42"}` unwraps
    // to, so the live turn and a later replay agree.
    expect(payloadFor(spy, TOOL_CALL_ID)).toEqual({A: 42});
  });

  it('records nothing for a structured reply, which is already recorded', async () => {
    const {spy, yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      userStructured(CURRENT_INVOCATION, 'A', 'approve'),
    ]);

    expect(yielded).toEqual([]);
    expect(payloadFor(spy, TOOL_CALL_ID)).toEqual({A: 'approve'});
  });

  it('answers the second pause from the second typed reply', async () => {
    const {spy, yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      userText('inv-2', 'first answer'),
      // The record turn 2 left behind, which turn 3 must not read as a reply.
      userStructured('inv-2', 'A', 'first answer'),
      interrupt('B'),
      userText(CURRENT_INVOCATION, 'second answer'),
    ]);

    expect(payloadFor(spy, TOOL_CALL_ID)).toEqual({B: 'second answer'});
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
    const {yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      userText(CURRENT_INVOCATION, 'hello'),
    ]);

    expect(yielded).toEqual([]);
  });

  it('records nothing when the turn that paused has no user event', async () => {
    const {yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
    ]);

    expect(yielded).toEqual([]);
  });

  it('records nothing for a reply that is not plain text', async () => {
    const image = createEvent({
      invocationId: CURRENT_INVOCATION,
      author: 'user',
      content: {
        role: 'user',
        parts: [{inlineData: {mimeType: 'image/png', data: 'aGk='}}],
      },
    });

    const {yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      image,
    ]);

    expect(yielded).toEqual([]);
  });

  it('ignores a user function response that answers no interrupt', async () => {
    const foreign = createEvent({
      invocationId: CURRENT_INVOCATION,
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

    const {yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      foreign,
    ]);

    expect(yielded).toEqual([]);
  });

  it('records nothing when the node-tool call is already answered', async () => {
    const {yielded} = await runProcessor([
      nodeToolCall(CURRENT_INVOCATION),
      interrupt('A'),
      nodeToolResponse(),
      userText(CURRENT_INVOCATION, 'approve'),
    ]);

    expect(yielded).toEqual([]);
  });

  it('records nothing when the agent has no node-tool', async () => {
    const {yielded} = await runProcessor(
      [
        nodeToolCall(CURRENT_INVOCATION),
        interrupt('A'),
        userText(CURRENT_INVOCATION, 'approve'),
      ],
      new LlmAgent({name: 'plain_agent', model: 'gemini-2.5-flash'}),
    );

    expect(yielded).toEqual([]);
  });

  it('rejects a structured reply that violates its declared schema', async () => {
    await expect(
      runProcessor([
        nodeToolCall(CURRENT_INVOCATION),
        interrupt('A', z.object({approved: z.boolean()})),
        userStructured(CURRENT_INVOCATION, 'A', '{"approved":"yes"}'),
      ]),
    ).rejects.toThrow(/reply to interrupt 'A' does not match/i);
  });
});
