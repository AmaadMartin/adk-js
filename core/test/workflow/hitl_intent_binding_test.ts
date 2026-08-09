/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionResponse, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthScheme} from '../../src/auth/auth_schemes.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {
  isRequestInputMismatchError,
  ResumeMismatchReason,
} from '../../src/workflow/errors.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {NodeTool} from '../../src/workflow/nodes/node_tool.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  createAuthRequestEvent,
  createRequestInputEvent,
  readFrozenRequests,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  verifyResumeResponse,
} from '../../src/workflow/utils/hitl_utils.js';
import {reconstructNodeStates} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

const INTERRUPT_ID = 'approve-1';
const FROZEN_PAYLOAD = {action: 'refund', to: 'alice', amount: 5};

/** The auth config an auth-gated node requests a credential for. */
function apiKeyAuthConfig(): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'} as AuthScheme,
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
    credentialKey: 'my_api',
  };
}

/** The interrupt event a gate node emits when it freezes {@link FROZEN_PAYLOAD}. */
function frozenInterruptEvent(): Event {
  const event = createRequestInputEvent(
    new RequestInput({
      interruptId: INTERRUPT_ID,
      payload: FROZEN_PAYLOAD,
      message: 'Approve this refund?',
    }),
  );
  event.author = 'gate';
  event.nodeInfo = {path: 'wf.gate'};
  return event;
}

/** A user event carrying a single resume function response. */
function userResponseEvent(response: FunctionResponse): Event {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{functionResponse: response}]},
  });
}

describe('readFrozenRequests', () => {
  it('reads the id, name and payload frozen on a request-input interrupt', () => {
    const frozen = readFrozenRequests(frozenInterruptEvent());

    expect(frozen).toHaveLength(1);
    expect(frozen[0].interruptId).toBe(INTERRUPT_ID);
    expect(frozen[0].name).toBe(REQUEST_INPUT_FUNCTION_CALL_NAME);
    expect(frozen[0].payload).toEqual(FROZEN_PAYLOAD);
  });

  it('reads a credential interrupt, which freezes no payload', () => {
    const frozen = readFrozenRequests(
      createAuthRequestEvent(apiKeyAuthConfig(), INTERRUPT_ID),
    );

    expect(frozen).toHaveLength(1);
    expect(frozen[0].name).toBe(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
    expect(frozen[0].payload).toBeUndefined();
  });

  it('freezes a null payload for a message-only request', () => {
    const event = createRequestInputEvent(
      new RequestInput({interruptId: INTERRUPT_ID, message: 'Approve?'}),
    );

    expect(readFrozenRequests(event)[0].payload).toBeNull();
  });

  it('returns nothing for an event with no long-running tool ids', () => {
    const event = createEvent({
      author: 'gate',
      nodeInfo: {path: 'wf.gate'},
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              id: INTERRUPT_ID,
              args: {},
            },
          },
        ],
      },
    });

    expect(readFrozenRequests(event)).toEqual([]);
  });

  it('returns nothing for an interrupt event with no function-call part', () => {
    const event = createEvent({
      author: 'gate',
      nodeInfo: {path: 'wf.gate'},
      longRunningToolIds: [INTERRUPT_ID],
    });

    expect(readFrozenRequests(event)).toEqual([]);
  });

  it('ignores a function call whose id is not a long-running tool id', () => {
    const event = createEvent({
      author: 'gate',
      nodeInfo: {path: 'wf.gate'},
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'transfer_funds', id: 'other-1', args: {}}},
        ],
      },
      longRunningToolIds: [INTERRUPT_ID],
    });

    expect(readFrozenRequests(event)).toEqual([]);
  });
});

describe('verifyResumeResponse', () => {
  const frozen = {
    interruptId: INTERRUPT_ID,
    name: REQUEST_INPUT_FUNCTION_CALL_NAME,
    payload: FROZEN_PAYLOAD,
  };

  /** A resume response answering {@link INTERRUPT_ID}, named unless overridden. */
  function resumeResponse(
    response?: Record<string, unknown>,
    name: string | undefined = REQUEST_INPUT_FUNCTION_CALL_NAME,
  ): FunctionResponse {
    return {id: INTERRUPT_ID, name, response};
  }

  it('reports WRONG_FUNCTION when the response names another function', () => {
    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({result: 'approved'}, 'transfer_funds'),
    );

    expect(reason).toBe(ResumeMismatchReason.WRONG_FUNCTION);
  });

  it('accepts a response that omits the function name', () => {
    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({result: 'approved'}, undefined),
    );

    expect(reason).toBeUndefined();
  });

  it('accepts an echoed payload whose keys are in a different order', () => {
    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({
        payload: {amount: 5, to: 'alice', action: 'refund'},
        result: 'approved',
      }),
    );

    expect(reason).toBeUndefined();
  });

  it('reports PAYLOAD_MISMATCH when the echoed payload differs', () => {
    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({
        payload: {action: 'refund', to: 'bob', amount: 5000},
        result: 'approved',
      }),
    );

    expect(reason).toBe(ResumeMismatchReason.PAYLOAD_MISMATCH);
  });

  it('reports PAYLOAD_MISMATCH when an echoed list is reordered', () => {
    const reason = verifyResumeResponse(
      {...frozen, payload: {items: ['alice', 'bob']}},
      resumeResponse({payload: {items: ['bob', 'alice']}}),
    );

    expect(reason).toBe(ResumeMismatchReason.PAYLOAD_MISMATCH);
  });

  it('accepts an echo of a frozen Date the wire could only carry as a string', () => {
    const due = new Date('2026-01-02T03:04:05.000Z');
    const reason = verifyResumeResponse(
      {...frozen, payload: {due}},
      resumeResponse({payload: {due: due.toISOString()}}),
    );

    expect(reason).toBeUndefined();
  });

  it('accepts an echo that omits a frozen key whose value is undefined', () => {
    const reason = verifyResumeResponse(
      {...frozen, payload: {to: 'alice', note: undefined}},
      resumeResponse({payload: {to: 'alice'}}),
    );

    expect(reason).toBeUndefined();
  });

  it('reports PAYLOAD_MISMATCH when the echoed payload is undefined', () => {
    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({payload: undefined}),
    );

    expect(reason).toBe(ResumeMismatchReason.PAYLOAD_MISMATCH);
  });

  it('reports PAYLOAD_MISMATCH when the echoed payload cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({payload: cyclic}),
    );

    expect(reason).toBe(ResumeMismatchReason.PAYLOAD_MISMATCH);
  });

  it('accepts a response that echoes no payload', () => {
    const reason = verifyResumeResponse(
      frozen,
      resumeResponse({result: 'approved'}),
    );

    expect(reason).toBeUndefined();
  });

  it('accepts a response with no body', () => {
    expect(verifyResumeResponse(frozen, resumeResponse())).toBeUndefined();
  });

  it('accepts a response whose body is not a record', () => {
    // A persisted body can be any JSON value despite the declared Record type,
    // and a body with no readable payload key cannot contradict the frozen one.
    const response: FunctionResponse = JSON.parse(
      `{"id": "${INTERRUPT_ID}", "name": "${REQUEST_INPUT_FUNCTION_CALL_NAME}", "response": ["approved"]}`,
    );

    expect(verifyResumeResponse(frozen, response)).toBeUndefined();
  });

  it('leaves the payload check inert when the request froze no payload', () => {
    const reason = verifyResumeResponse(
      {...frozen, payload: null},
      resumeResponse({payload: {anything: true}, result: 'approved'}),
    );

    expect(reason).toBeUndefined();
  });
});

describe('reconstructNodeStates — resume intent binding', () => {
  it('records a payload mismatch instead of resolving the interrupt', () => {
    const states = reconstructNodeStates([
      frozenInterruptEvent(),
      userResponseEvent({
        id: INTERRUPT_ID,
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {
          payload: {action: 'refund', to: 'bob', amount: 5000},
          result: 'approved',
        },
      }),
    ]);

    const gate = states.get('gate');
    expect(gate?.resolvedResponses.has(INTERRUPT_ID)).toBe(false);
    expect(gate?.mismatchedResponses.get(INTERRUPT_ID)).toBe(
      ResumeMismatchReason.PAYLOAD_MISMATCH,
    );
  });

  it('records WRONG_FUNCTION when a credential interrupt is answered as a request-input', () => {
    const interrupt = createAuthRequestEvent(apiKeyAuthConfig(), INTERRUPT_ID);
    interrupt.author = 'secured';
    interrupt.nodeInfo = {path: 'wf.secured'};

    const states = reconstructNodeStates([
      interrupt,
      userResponseEvent({
        id: INTERRUPT_ID,
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {result: 'secret-key'},
      }),
    ]);

    const secured = states.get('secured');
    expect(secured?.resolvedResponses.has(INTERRUPT_ID)).toBe(false);
    expect(secured?.mismatchedResponses.get(INTERRUPT_ID)).toBe(
      ResumeMismatchReason.WRONG_FUNCTION,
    );
  });

  it('lets a later valid response clear an earlier mismatch', () => {
    const states = reconstructNodeStates([
      frozenInterruptEvent(),
      userResponseEvent({
        id: INTERRUPT_ID,
        name: 'transfer_funds',
        response: {result: 'approved'},
      }),
      userResponseEvent({
        id: INTERRUPT_ID,
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {result: 'approved'},
      }),
    ]);

    const gate = states.get('gate');
    expect(gate?.resolvedResponses.get(INTERRUPT_ID)).toBe('approved');
    expect(gate?.mismatchedResponses.size).toBe(0);
  });

  it('lets a later mismatch drop an earlier resolution', () => {
    const states = reconstructNodeStates([
      frozenInterruptEvent(),
      userResponseEvent({
        id: INTERRUPT_ID,
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {result: 'approved'},
      }),
      userResponseEvent({
        id: INTERRUPT_ID,
        name: 'transfer_funds',
        response: {result: 'approved'},
      }),
    ]);

    const gate = states.get('gate');
    expect(gate?.resolvedResponses.has(INTERRUPT_ID)).toBe(false);
    expect(gate?.mismatchedResponses.get(INTERRUPT_ID)).toBe(
      ResumeMismatchReason.WRONG_FUNCTION,
    );
  });

  it('still resolves an interrupt event that froze no request', () => {
    const states = reconstructNodeStates([
      createEvent({
        author: 'gate',
        nodeInfo: {path: 'wf.gate'},
        longRunningToolIds: [INTERRUPT_ID],
      }),
      userResponseEvent({
        id: INTERRUPT_ID,
        name: 'transfer_funds',
        response: {result: 'approved'},
      }),
    ]);

    const gate = states.get('gate');
    expect(gate?.resolvedResponses.get(INTERRUPT_ID)).toBe('approved');
    expect(gate?.mismatchedResponses.size).toBe(0);
  });
});

/** Builds a refund-approval workflow that records every action it executes. */
function refundWorkflow(): {executed: unknown[]; agent: WorkflowAgent} {
  const executed: unknown[] = [];
  const gate = node(
    (ctx: NodeContext) => {
      const answer = ctx.resumeInputs[INTERRUPT_ID];
      if (answer === undefined) {
        return new RequestInput({
          interruptId: INTERRUPT_ID,
          payload: FROZEN_PAYLOAD,
          message: 'Approve this refund?',
        });
      }
      executed.push(answer);
      return 'executed';
    },
    {name: 'gate', rerunOnResume: true},
  );
  const wf = new Workflow({name: 'refund_wf', edges: [['START', gate]]});
  return {executed, agent: new WorkflowAgent(wf)};
}

/** The same refund workflow, shaped so a {@link NodeTool} can wrap it. */
function refundToolWorkflow(): {executed: unknown[]; workflow: Workflow} {
  const executed: unknown[] = [];
  const gate = node(
    (ctx: NodeContext) => {
      const answer = ctx.resumeInputs[INTERRUPT_ID];
      if (answer === undefined) {
        return new RequestInput({
          interruptId: INTERRUPT_ID,
          payload: FROZEN_PAYLOAD,
          message: 'Approve this refund?',
        });
      }
      executed.push(answer);
      return 'executed';
    },
    {name: 'gate', rerunOnResume: true},
  );
  const workflow = new Workflow({
    name: TOOL_NAME,
    description: 'Approves and executes a refund.',
    inputSchema: z.object({amount: z.number()}),
    edges: [['START', gate]],
  });
  return {executed, workflow};
}

/** Drives one turn of a workflow through a real Runner, collecting its events. */
async function runTurn(
  runner: Runner,
  sessionId: string,
  parts: Part[],
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'u1',
    sessionId,
    newMessage: {role: 'user', parts},
  })) {
    events.push(event);
  }
  return events;
}

describe('workflow resume — approve-A / execute-B', () => {
  async function pauseOnRefund(): Promise<{
    executed: unknown[];
    runner: Runner;
    sessionId: string;
  }> {
    const {executed, agent} = refundWorkflow();
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    await runTurn(runner, session.id, [{text: 'refund alice 5'}]);
    expect(executed).toEqual([]);

    return {executed, runner, sessionId: session.id};
  }

  it('aborts the run when the resume response echoes a different payload', async () => {
    const {executed, runner, sessionId} = await pauseOnRefund();

    const turn2 = runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: {
            payload: {action: 'refund', to: 'bob', amount: 5000},
            result: 'approved',
          },
        },
      },
    ]);

    await expect(turn2).rejects.toSatisfy(isRequestInputMismatchError);
    await expect(turn2).rejects.toMatchObject({
      reason: ResumeMismatchReason.PAYLOAD_MISMATCH,
      interruptId: INTERRUPT_ID,
      nodeName: 'gate',
    });
    expect(executed).toEqual([]);
  });

  it('aborts the run when the resume response names another function', async () => {
    const {executed, runner, sessionId} = await pauseOnRefund();

    const turn2 = runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: 'transfer_funds',
          response: {result: 'approved'},
        },
      },
    ]);

    await expect(turn2).rejects.toSatisfy(isRequestInputMismatchError);
    await expect(turn2).rejects.toMatchObject({
      reason: ResumeMismatchReason.WRONG_FUNCTION,
    });
    expect(executed).toEqual([]);
  });

  it('resumes when the response echoes the frozen payload with shuffled keys', async () => {
    const {executed, runner, sessionId} = await pauseOnRefund();

    const echoed = {
      payload: {amount: 5, to: 'alice', action: 'refund'},
      result: 'approved',
    };
    const turn2 = await runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: echoed,
        },
      },
    ]);

    // A multi-key response body is not unwrapped, so the node sees it whole.
    expect(executed).toEqual([echoed]);
    expect(turn2.some((e) => e.output === 'executed')).toBe(true);
  });

  it('keeps aborting when a plain-text reply follows a mismatch', async () => {
    const {executed, runner, sessionId} = await pauseOnRefund();

    const turn2 = runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: 'transfer_funds',
          response: {result: 'approved'},
        },
      },
    ]);
    await expect(turn2).rejects.toSatisfy(isRequestInputMismatchError);

    // A resume value seeded outside the verified scan does not excuse the
    // mismatch. A plain-text reply maps to the still-pending interrupt, so
    // honouring it here would be an opening for any other such seed.
    const turn3 = runTurn(runner, sessionId, [{text: 'approved'}]);

    await expect(turn3).rejects.toSatisfy(isRequestInputMismatchError);
    expect(executed).toEqual([]);
  });

  it('recovers when a well-formed response follows a mismatch', async () => {
    const {executed, runner, sessionId} = await pauseOnRefund();

    const turn2 = runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: 'transfer_funds',
          response: {result: 'approved'},
        },
      },
    ]);
    await expect(turn2).rejects.toSatisfy(isRequestInputMismatchError);

    const turn3 = await runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: {result: 'approved'},
        },
      },
    ]);

    expect(executed).toEqual(['approved']);
    expect(turn3.some((e) => e.output === 'executed')).toBe(true);
  });

  it('resumes when the response echoes no payload', async () => {
    const {executed, runner, sessionId} = await pauseOnRefund();

    const turn2 = await runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: {result: 'approved'},
        },
      },
    ]);

    expect(executed).toEqual(['approved']);
    expect(turn2.some((e) => e.output === 'executed')).toBe(true);
  });
});

/** A model that replays a fixed list of responses, one per call. */
class ScriptedLlm extends BaseLlm {
  private callCount = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.responses[this.callCount++];
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live mode is not supported by ScriptedLlm.');
  }
}

const TOOL_CALL_ID = 'call-1';
const TOOL_NAME = 'refund_wf';

/**
 * The second HITL entry point: an `LlmAgent` calls the same workflow through a
 * {@link NodeTool}, which seeds the node's resume inputs from the tool
 * confirmation payload rather than from the verified rehydration scan.
 */
describe('NodeTool resume — approve-A / execute-B', () => {
  async function pauseOnRefundTool(): Promise<{
    executed: unknown[];
    runner: Runner;
    sessionId: string;
  }> {
    const {executed, workflow} = refundToolWorkflow();
    const agent = new LlmAgent({
      name: 'root',
      model: new ScriptedLlm([
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: TOOL_CALL_ID,
                  name: TOOL_NAME,
                  args: {amount: 5},
                },
              },
            ],
          },
        },
      ]),
      tools: [new NodeTool(workflow)],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    const turn1 = await runTurn(runner, session.id, [{text: 'refund alice 5'}]);

    expect(executed).toEqual([]);
    expect(
      turn1.some((e) => (e.longRunningToolIds ?? []).includes(INTERRUPT_ID)),
    ).toBe(true);

    return {executed, runner, sessionId: session.id};
  }

  it('never executes the node when the resume response echoes a different payload', async () => {
    const {executed, runner, sessionId} = await pauseOnRefundTool();

    const turn2 = runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: {
            payload: {action: 'refund', to: 'bob', amount: 5000},
            result: 'approved',
          },
        },
      },
    ]);

    // The turn fails and the node body never runs. The agent's tool-call step
    // converts any error a node-tool throws into a tool error before the caller
    // sees it, so the rejection here is not the RequestInputMismatchError
    // itself; the empty `executed` array is the property under test.
    await expect(turn2).rejects.toThrow();
    expect(executed).toEqual([]);
  });

  it('resumes when the response echoes the frozen payload', async () => {
    const {executed, runner, sessionId} = await pauseOnRefundTool();

    await runTurn(runner, sessionId, [
      {
        functionResponse: {
          id: INTERRUPT_ID,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: {payload: FROZEN_PAYLOAD, result: 'approved'},
        },
      },
    ]);

    expect(executed).toEqual([{payload: FROZEN_PAYLOAD, result: 'approved'}]);
  });
});
