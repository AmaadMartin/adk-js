/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseAgent,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SequentialAgent,
  createEvent,
  createSession,
} from '@google/adk';
import {Mock, describe, expect, it, vi} from 'vitest';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../src/agents/functions.js';

vi.mock('../../src/agents/functions.js', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    handleFunctionCallsAsync: Mock;
  };
  return {
    ...actual,
    handleFunctionCallsAsync: vi.fn().mockResolvedValue({
      id: 'mockResponseEvent',
      author: 'system',
    } as Event),
  };
});

vi.mock('../../src/auth/auth_handler.js', () => ({
  AuthHandler: class {
    parseAndStoreAuthResponse = vi.fn().mockResolvedValue(undefined);
  },
}));

function createTestInvocationContext(
  agent: BaseAgent,
  events: Event[] = [],
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager([]),
  });
}

describe('AuthPreprocessor', () => {
  it('skips if agent is not LlmAgent', async () => {
    const invocationContext = createTestInvocationContext(
      new SequentialAgent({name: 'not_an_llm_agent'}),
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if no events are present', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if last event is not from user', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [createEvent({author: 'system', content: {parts: [{text: 'hello'}]}})],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if no function responses for request_credential are found', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'user',
          content: {
            parts: [{text: 'hello'}],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('processes adk_request_credential responses and resumes tools', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'agent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'toolFc1',
                  name: 'someTool',
                  args: {},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'agent',
          content: {
            parts: [{text: 'thinking...'}],
          },
        }),
        createEvent({
          author: 'agent',
          id: 'originalEvent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  args: {
                    authConfig: {credentialKey: 'testKey'},
                    functionCallId: 'toolFc1',
                  },
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {authType: 'apiKey', apiKey: 'test'},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    let result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      id: 'mockResponseEvent',
      author: 'system',
    });

    result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('processes adk_request_credential responses and resumes tools (snake_case args)', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'agent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'toolFc1',
                  name: 'someTool',
                  args: {},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'agent',
          id: 'originalEvent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  args: {
                    auth_config: {credentialKey: 'testKey'},
                    function_call_id: 'toolFc1',
                  },
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {authType: 'apiKey', apiKey: 'test'},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    let result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      id: 'mockResponseEvent',
      author: 'system',
    });

    result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('processes adk_request_credential responses and resumes tools (deep snake_case args)', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'agent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'toolFc1',
                  name: 'someTool',
                  args: {},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'agent',
          id: 'originalEvent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  args: {
                    auth_config: {credential_key: 'testKey'},
                    function_call_id: 'toolFc1',
                  },
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {authType: 'apiKey', apiKey: 'test'},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    let result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      id: 'mockResponseEvent',
      author: 'system',
    });

    result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('skips if function responses exist but not for request_credential', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'some_other_fc',
                  name: 'some_other_tool',
                  response: {},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if tools to resume is empty (e.g. toolset auth)', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'agent',
          id: 'originalEvent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  args: {
                    authConfig: {credentialKey: 'testKey'},
                    functionCallId: '_adk_toolset_auth_something',
                  },
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {authType: 'apiKey', apiKey: 'test'},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if original function call is not found in history', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {authType: 'apiKey', apiKey: 'test'},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('handles function calls without ids in history', async () => {
    const invocationContext = createTestInvocationContext(
      new LlmAgent({name: 'test_agent'}),
      [
        createEvent({
          author: 'agent',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'someTool',
                  args: {},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'agent',
          id: 'originalEvent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  args: {
                    authConfig: {credentialKey: 'testKey'},
                    functionCallId: 'toolFc1',
                  },
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'fc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {authType: 'apiKey', apiKey: 'test'},
                },
              },
            ],
          },
        }),
      ],
    );

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });
});
