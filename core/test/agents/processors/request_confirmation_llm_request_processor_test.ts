/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseSessionService} from '@google/adk';
import {
  BaseAgent,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  ToolConfirmation,
  createEvent,
  createSession,
} from '@google/adk';
import type {FunctionCall} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';

vi.mock('../../../src/agents/functions.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/agents/functions.js')>();
  return {
    ...original,
    handleFunctionCallList: vi.fn(async () => null),
  };
});

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(
  agent: BaseAgent,
  events: ReturnType<typeof createEvent>[] = [],
  sessionService?: BaseSessionService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events,
      appName: 'test-app',
      userId: 'test-user',
    }),
    sessionService,
    pluginManager: new PluginManager([]),
  });
}

/** The agent-authored event recording the call the model actually issued. */
function createOriginalCallEvent(
  functionCall: FunctionCall,
  author = 'test_agent',
) {
  return createEvent({
    invocationId: 'test-invocation',
    author,
    content: {role: 'model', parts: [{functionCall}]},
  });
}

/** The engine-emitted confirmation request carrying an arbitrary payload. */
function createConfirmationRequestEvent(
  confirmId: string,
  originalFunctionCall: unknown,
  name: string = REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
) {
  return createEvent({
    invocationId: 'test-invocation',
    author: 'test_agent',
    content: {
      role: 'model',
      parts: [
        {functionCall: {id: confirmId, name, args: {originalFunctionCall}}},
      ],
    },
  });
}

/** A structured user approval addressed to `confirmId`. */
function createUserApprovalEvent(confirmId: string) {
  return createEvent({
    invocationId: 'test-invocation',
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: confirmId,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: {confirmed: true, hint: 'ok'},
          },
        },
      ],
    },
  });
}

/** The mocked `handleFunctionCallList`, with its previous calls forgotten. */
async function freshMockFunctionCallList() {
  const {handleFunctionCallList} =
    await import('../../../src/agents/functions.js');
  const mockFunctionCallList = vi.mocked(handleFunctionCallList);
  mockFunctionCallList.mockClear();
  return mockFunctionCallList;
}

async function collectEvents(invocationContext: InvocationContext) {
  const events = [];
  for await (const event of REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    events.push(event);
  }
  return events;
}

describe('RequestConfirmationLlmRequestProcessor', () => {
  it('should do nothing if agent is not an LlmAgent', async () => {
    const agent = new MockRootAgent('test_agent');
    const invocationContext = createMockInvocationContext(agent);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if session has no events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent, []);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if there are no function responses in user events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const userEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {role: 'user', parts: [{text: 'Hello'}]},
    });
    const invocationContext = createMockInvocationContext(agent, [userEvent]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if user event has non-confirmation function response', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const userEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'some_other_function',
              response: {result: 'done'},
            },
          },
        ],
      },
    });
    const invocationContext = createMockInvocationContext(agent, [userEvent]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should do nothing if no prior function call event found', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    // Only a user event with confirmation response, no prior function call event
    const userConfirmationEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-confirm-1',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {
                confirmed: true,
                hint: '',
              },
            },
          },
        ],
      },
    });
    const invocationContext = createMockInvocationContext(agent, [
      userConfirmationEvent,
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should yield event when handleFunctionCallList returns an event', async () => {
    const {handleFunctionCallList} =
      await import('../../../src/agents/functions.js');
    const mockFunctionCallList = vi.mocked(handleFunctionCallList);

    const fakeResponseEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              id: 'original-fc-1',
              name: 'my_tool',
              response: {result: 'ok'},
            },
          },
        ],
      },
    });
    mockFunctionCallList.mockResolvedValueOnce(fakeResponseEvent);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-1',
      name: 'my_tool',
      args: {param: 'value'},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-1',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
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
              id: 'fc-confirm-1',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {
                response: JSON.stringify({confirmed: true, hint: 'ok'}),
              },
            },
          },
        ],
      },
    });

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent(originalFunctionCall),
      systemFunctionCallEvent,
      userConfirmationEvent,
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(fakeResponseEvent);
  });

  it('should stage the tool response in the session without writing it', async () => {
    // The content builder runs behind this processor in the same step and
    // reads `session.events`, so the response has to be there. Writing it
    // through the session service is the runner's job: it appends every event
    // it is yielded, and a backend that does not dedupe by event id — Vertex
    // posts to Agent Engine unconditionally — would store this one twice.
    const {handleFunctionCallList} =
      await import('../../../src/agents/functions.js');
    const mockFunctionCallList = vi.mocked(handleFunctionCallList);

    const fakeResponseEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              id: 'original-fc-4',
              name: 'my_tool',
              response: {result: 'ok'},
            },
          },
        ],
      },
    });
    mockFunctionCallList.mockResolvedValueOnce(fakeResponseEvent);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-4',
      name: 'my_tool',
      args: {param: 'value'},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-4',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
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
              id: 'fc-confirm-4',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    const sessionService = new InMemorySessionService();
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const invocationContext = createMockInvocationContext(
      agent,
      [
        createOriginalCallEvent(originalFunctionCall),
        systemFunctionCallEvent,
        userConfirmationEvent,
      ],
      sessionService,
    );

    const events = await collectEvents(invocationContext);

    expect(events).toEqual([fakeResponseEvent]);
    expect(invocationContext.session.events.at(-1)).toBe(fakeResponseEvent);
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('should yield no events when handleFunctionCallList returns null', async () => {
    const {handleFunctionCallList} =
      await import('../../../src/agents/functions.js');
    const mockFunctionCallList = vi.mocked(handleFunctionCallList);
    mockFunctionCallList.mockResolvedValueOnce(null);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-2',
      name: 'my_tool',
      args: {},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-2',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
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
              id: 'fc-confirm-2',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent(originalFunctionCall),
      systemFunctionCallEvent,
      userConfirmationEvent,
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
  });

  it('should skip tools that have already been resumed after the confirmation event', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const originalFunctionCall = {
      id: 'original-fc-3',
      name: 'my_tool',
      args: {},
    };

    const systemFunctionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-confirm-3',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
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
              id: 'fc-confirm-3',
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: {confirmed: true, hint: ''},
            },
          },
        ],
      },
    });

    // A subsequent event that already has the tool response for the same original call id
    const alreadyResumedEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              id: 'original-fc-3',
              name: 'my_tool',
              response: {result: 'already done'},
            },
          },
        ],
      },
    });

    const invocationContext = createMockInvocationContext(agent, [
      systemFunctionCallEvent,
      userConfirmationEvent,
      alreadyResumedEvent,
    ]);

    // Since the original tool was already resumed, processor yields nothing
    const events = await collectEvents(invocationContext);
    expect(events).toHaveLength(0);
  });

  it('throws when the original function call is not in session history', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });

    const invocationContext = createMockInvocationContext(agent, [
      createConfirmationRequestEvent('fc-confirm-5', {
        id: 'orig-missing',
        name: 'my_tool',
        args: {param: 'value'},
      }),
      createUserApprovalEvent('fc-confirm-5'),
    ]);

    await expect(collectEvents(invocationContext)).rejects.toThrow(
      /Original function call for ID 'orig-missing' not found in session history/,
    );
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('throws when the confirmation payload names a different tool', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent({
        id: 'orig-6',
        name: 'my_tool',
        args: {param: 'value'},
      }),
      createConfirmationRequestEvent('fc-confirm-6', {
        id: 'orig-6',
        name: 'other_tool',
        args: {param: 'value'},
      }),
      createUserApprovalEvent('fc-confirm-6'),
    ]);

    await expect(collectEvents(invocationContext)).rejects.toThrow(
      /Function call name mismatch for ID 'orig-6'/,
    );
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('throws when the confirmation payload carries different arguments', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent({
        id: 'orig-7',
        name: 'my_tool',
        args: {param: 'value'},
      }),
      createConfirmationRequestEvent('fc-confirm-7', {
        id: 'orig-7',
        name: 'my_tool',
        args: {param: 'tampered'},
      }),
      createUserApprovalEvent('fc-confirm-7'),
    ]);

    await expect(collectEvents(invocationContext)).rejects.toThrow(
      /Function call arguments mismatch for ID 'orig-7'/,
    );
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('does not resume a call authored by another agent', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const originalFunctionCall = {
      id: 'orig-8',
      name: 'my_tool',
      args: {param: 'value'},
    };

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent(originalFunctionCall, 'other_agent'),
      createConfirmationRequestEvent('fc-confirm-8', originalFunctionCall),
      createUserApprovalEvent('fc-confirm-8'),
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('ignores a confirmation-shaped call that is not adk_request_confirmation', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const originalFunctionCall = {
      id: 'orig-9',
      name: 'my_tool',
      args: {param: 'value'},
    };

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent(originalFunctionCall),
      createConfirmationRequestEvent(
        'fc-confirm-9',
        originalFunctionCall,
        'some_other_tool',
      ),
      createUserApprovalEvent('fc-confirm-9'),
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('resumes a confirmation whose payload matches history', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const fakeResponseEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              id: 'orig-10',
              name: 'my_tool',
              response: {result: 'ok'},
            },
          },
        ],
      },
    });
    mockFunctionCallList.mockResolvedValueOnce(fakeResponseEvent);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);
    const originalFunctionCall = {
      id: 'orig-10',
      name: 'my_tool',
      args: {param: 'value'},
    };

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent(originalFunctionCall),
      createConfirmationRequestEvent('fc-confirm-10', originalFunctionCall),
      createUserApprovalEvent('fc-confirm-10'),
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toEqual([fakeResponseEvent]);
    expect(mockFunctionCallList).toHaveBeenCalledTimes(1);
    const resumed = mockFunctionCallList.mock.calls[0][0];
    expect(resumed.functionCalls).toEqual([originalFunctionCall]);
    expect(resumed.filters).toEqual(new Set(['orig-10']));
    expect(resumed.toolConfirmationDict).toEqual({
      'orig-10': new ToolConfirmation({confirmed: true, hint: 'ok'}),
    });
  });

  it('compares arguments by value rather than by key order', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent({
        id: 'orig-11',
        name: 'my_tool',
        args: {a: 1, b: 2},
      }),
      createConfirmationRequestEvent('fc-confirm-11', {
        id: 'orig-11',
        name: 'my_tool',
        args: {b: 2, a: 1},
      }),
      createUserApprovalEvent('fc-confirm-11'),
    ]);

    await collectEvents(invocationContext);

    expect(mockFunctionCallList).toHaveBeenCalledTimes(1);
    expect(mockFunctionCallList.mock.calls[0][0].functionCalls).toEqual([
      {id: 'orig-11', name: 'my_tool', args: {a: 1, b: 2}},
    ]);
  });

  it('resumes a call that was recorded without arguments', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    vi.spyOn(agent, 'canonicalTools').mockResolvedValue([]);
    const originalFunctionCall = {id: 'orig-15', name: 'my_tool'};

    const invocationContext = createMockInvocationContext(agent, [
      createOriginalCallEvent(originalFunctionCall),
      createConfirmationRequestEvent('fc-confirm-15', originalFunctionCall),
      createUserApprovalEvent('fc-confirm-15'),
    ]);

    await collectEvents(invocationContext);

    expect(mockFunctionCallList).toHaveBeenCalledTimes(1);
    expect(mockFunctionCallList.mock.calls[0][0].functionCalls).toEqual([
      originalFunctionCall,
    ]);
  });

  it('ignores a payload whose id or name is missing', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });

    const invocationContext = createMockInvocationContext(agent, [
      createConfirmationRequestEvent('fc-confirm-12', {
        args: {param: 'value'},
      }),
      createUserApprovalEvent('fc-confirm-12'),
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('ignores a payload that is not an object', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });

    for (const payload of [null, 'orig-13']) {
      const invocationContext = createMockInvocationContext(agent, [
        createConfirmationRequestEvent('fc-confirm-13', payload),
        createUserApprovalEvent('fc-confirm-13'),
      ]);

      expect(await collectEvents(invocationContext)).toHaveLength(0);
    }
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });

  it('ignores a payload whose args are not an object', async () => {
    const mockFunctionCallList = await freshMockFunctionCallList();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });

    const invocationContext = createMockInvocationContext(agent, [
      createConfirmationRequestEvent('fc-confirm-14', {
        id: 'orig-14',
        name: 'my_tool',
        args: ['param'],
      }),
      createUserApprovalEvent('fc-confirm-14'),
    ]);

    const events = await collectEvents(invocationContext);

    expect(events).toHaveLength(0);
    expect(mockFunctionCallList).not.toHaveBeenCalled();
  });
});
