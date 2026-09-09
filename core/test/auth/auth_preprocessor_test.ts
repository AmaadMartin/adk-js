/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  AuthConfig,
  AuthScheme,
  Event,
  InvocationContext,
  createEvent,
} from '@google/adk';
import {Mock, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  handleFunctionCallsAsync,
} from '../../src/agents/functions.js';

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

const {storeCredential} = vi.hoisted(() => ({
  storeCredential: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/auth/auth_handler.js', () => ({
  AuthHandler: class {
    parseAndStoreAuthResponse = storeCredential;
  },
}));

describe('AuthPreprocessor', () => {
  const LLM_AGENT_SYMBOL = Symbol.for('google.adk.llmAgent');

  /**
   * A credential request is only an authority if it says what is being
   * collected, so these fixtures carry a scheme and the response carries its
   * material under `exchangedAuthCredential`, as a real client sends it.
   */
  const API_KEY_SCHEME: AuthScheme = {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
  };
  const CREDENTIAL_RESPONSE = {
    exchangedAuthCredential: {authType: 'apiKey', apiKey: 'test'},
  };

  it('skips if agent is not LlmAgent', async () => {
    const invocationContext = {
      agent: {}, // Not an LlmAgent
      session: {events: []},
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if no events are present', async () => {
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {events: []},
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if last event is not from user', async () => {
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {
        events: [
          {author: 'system', content: {parts: [{text: 'hello'}]}} as Event,
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if no function responses for request_credential are found', async () => {
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {
        events: [
          {
            author: 'user',
            content: {
              parts: [{text: 'hello'}],
            },
          } as Event,
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('processes adk_request_credential responses and resumes tools', async () => {
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
        canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      session: {
        state: {},
        events: [
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
                      authConfig: {
                        credentialKey: 'testKey',
                        authScheme: API_KEY_SCHEME,
                      },
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
                    response: CREDENTIAL_RESPONSE,
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

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
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
        canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      session: {
        state: {},
        events: [
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
                      auth_config: {
                        credentialKey: 'testKey',
                        authScheme: API_KEY_SCHEME,
                      },
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
                    response: CREDENTIAL_RESPONSE,
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

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
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
        canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      session: {
        state: {},
        events: [
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
                      auth_config: {
                        credential_key: 'testKey',
                        auth_scheme: API_KEY_SCHEME,
                      },
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
                    response: CREDENTIAL_RESPONSE,
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

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
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {
        events: [
          {
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
          } as Event,
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if tools to resume is empty (e.g. toolset auth)', async () => {
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
      },
      session: {
        state: {},
        events: [
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
                      authConfig: {
                        credentialKey: 'testKey',
                        authScheme: API_KEY_SCHEME,
                      },
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
                    response: CREDENTIAL_RESPONSE,
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if original function call is not found in history', async () => {
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
        canonicalTools: vi.fn().mockResolvedValue([]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      session: {
        state: {},
        events: [
          createEvent({
            author: 'user',
            content: {
              parts: [
                {
                  functionResponse: {
                    id: 'fc1',
                    name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                    response: CREDENTIAL_RESPONSE,
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('handles function calls without ids in history', async () => {
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
        canonicalTools: vi.fn().mockResolvedValue([]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      session: {
        state: {},
        events: [
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
                      authConfig: {
                        credentialKey: 'testKey',
                        authScheme: API_KEY_SCHEME,
                      },
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
                    response: CREDENTIAL_RESPONSE,
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  // A credential request says which tool is waiting and where the credential
  // belongs. Only the agent gets to say that: a request written by the caller
  // is the caller describing its own errand.
  describe('credential request provenance', () => {
    /** A session whose credential request is authored by `requestAuthor`. */
    function contextWithRequestFrom(requestAuthor: string): InvocationContext {
      return {
        agent: {
          [LLM_AGENT_SYMBOL]: true,
          name: 'agent',
          canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
          canonicalBeforeToolCallbacks: [],
          canonicalAfterToolCallbacks: [],
        },
        session: {
          state: {},
          events: [
            createEvent({
              author: 'agent',
              content: {
                parts: [
                  {functionCall: {id: 'toolFc1', name: 'someTool', args: {}}},
                ],
              },
            }),
            createEvent({
              author: requestAuthor,
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'fc1',
                      name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                      args: {
                        authConfig: {
                          credentialKey: 'testKey',
                          authScheme: API_KEY_SCHEME,
                        },
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
                      response: CREDENTIAL_RESPONSE,
                    },
                  },
                ],
              },
            }),
          ],
        },
      } as unknown as InvocationContext;
    }

    beforeEach(() => {
      storeCredential.mockClear();
    });

    it('honours a request the agent raised', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextWithRequestFrom('agent'),
      );

      expect((await generator.next()).done).toBe(false);
      expect(storeCredential).toHaveBeenCalledTimes(1);
    });

    it('ignores a request the client wrote, storing nothing', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextWithRequestFrom('user'),
      );

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it('leaves another agent to handle its own request', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextWithRequestFrom('other_agent'),
      );

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it('ignores a credential nobody asked for', async () => {
      const invocationContext = {
        agent: {
          [LLM_AGENT_SYMBOL]: true,
          name: 'agent',
          canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
          canonicalBeforeToolCallbacks: [],
          canonicalAfterToolCallbacks: [],
        },
        session: {
          state: {},
          events: [
            createEvent({
              author: 'user',
              content: {
                parts: [
                  {
                    functionResponse: {
                      id: 'never-requested',
                      name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                      response: {
                        exchangedAuthCredential: {
                          authType: 'apiKey',
                          apiKey: 'attacker-key',
                        },
                      },
                    },
                  },
                ],
              },
            }),
          ],
        },
      } as unknown as InvocationContext;

      const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });
  });

  // The request is the authority for what is being collected and where it goes.
  // If it cannot play that part, there is nothing to reconcile the response
  // against, and storing what arrived would be taking the client's word for it.
  describe('credential request completeness', () => {
    /** A session pairing an arbitrary request config with a response. */
    function contextFor(
      authConfig: Record<string, unknown>,
      response: Record<string, unknown>,
    ): InvocationContext {
      return {
        agent: {
          [LLM_AGENT_SYMBOL]: true,
          name: 'agent',
          canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
          canonicalBeforeToolCallbacks: [],
          canonicalAfterToolCallbacks: [],
        },
        session: {
          state: {},
          events: [
            createEvent({
              author: 'agent',
              content: {
                parts: [
                  {functionCall: {id: 'toolFc1', name: 'someTool', args: {}}},
                ],
              },
            }),
            createEvent({
              author: 'agent',
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'fc1',
                      name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                      args: {authConfig, functionCallId: 'toolFc1'},
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
                      response,
                    },
                  },
                ],
              },
            }),
          ],
        },
      } as unknown as InvocationContext;
    }

    beforeEach(() => {
      storeCredential.mockClear();
    });

    it('refuses a request that names no auth scheme', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextFor({credentialKey: 'testKey'}, CREDENTIAL_RESPONSE),
      );

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it('refuses a request that names no credential key', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextFor({authScheme: API_KEY_SCHEME}, CREDENTIAL_RESPONSE),
      );

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it('refuses a response carrying no credential material', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextFor(
          {credentialKey: 'testKey', authScheme: API_KEY_SCHEME},
          {authScheme: API_KEY_SCHEME},
        ),
      );

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });
  });

  /** An invocation whose agent owns `someTool`, optionally on a branch. */
  function contextOn(events: Event[], branch?: string): InvocationContext {
    return {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        name: 'agent',
        canonicalTools: vi.fn().mockResolvedValue([{name: 'someTool'}]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      branch,
      session: {state: {}, events},
    } as unknown as InvocationContext;
  }

  function authConfigFor(credentialKey: string): AuthConfig {
    return {credentialKey, authScheme: API_KEY_SCHEME};
  }

  /** The agent's tool calls, as the model issued them. */
  function toolCallEvent(ids: string[], branch?: string): Event {
    return createEvent({
      author: 'agent',
      branch,
      content: {
        parts: ids.map((id) => ({
          functionCall: {id, name: 'someTool', args: {}},
        })),
      },
    });
  }

  /** An event recording which calls wait on which credential. */
  function pendingAuthEvent(
    pending: Record<string, string>,
    options: {author?: string; branch?: string} = {},
  ): Event {
    return createEvent({
      author: options.author ?? 'agent',
      branch: options.branch,
      actions: {
        requestedAuthConfigs: Object.fromEntries(
          Object.entries(pending).map(([fcId, credentialKey]) => [
            fcId,
            authConfigFor(credentialKey),
          ]),
        ),
      },
    });
  }

  /** The agent's `adk_request_credential` call naming `functionCallId`. */
  function credentialRequestEvent(
    functionCallId: string,
    options: {id?: string; credentialKey?: string; branch?: string} = {},
  ): Event {
    return createEvent({
      author: 'agent',
      branch: options.branch,
      content: {
        parts: [
          {
            functionCall: {
              id: options.id ?? 'fc1',
              name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
              args: {
                authConfig: authConfigFor(options.credentialKey ?? 'testKey'),
                functionCallId,
              },
            },
          },
        ],
      },
    });
  }

  /** The user's answer to those requests. */
  function credentialResponseEvent(
    options: {ids?: string[]; branch?: string} = {},
  ): Event {
    return createEvent({
      author: 'user',
      branch: options.branch,
      content: {
        parts: (options.ids ?? ['fc1']).map((id) => ({
          functionResponse: {
            id,
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            response: CREDENTIAL_RESPONSE,
          },
        })),
      },
    });
  }

  /** The resume set the one call to `handleFunctionCallsAsync` carried. */
  function resumedFilters(): Set<string> | undefined {
    const call = vi.mocked(handleFunctionCallsAsync).mock.calls[0];
    expect(call).toBeDefined();
    return call[0].filters;
  }

  describe('resuming siblings by credential key', () => {
    beforeEach(() => {
      vi.mocked(handleFunctionCallsAsync).mockClear();
      storeCredential.mockClear();
    });

    it('resumes every call awaiting the authorized credential key', async () => {
      const originalCalls = toolCallEvent(['toolFc1', 'toolFc2']);
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          originalCalls,
          pendingAuthEvent({toolFc1: 'testKey', toolFc2: 'testKey'}),
          credentialRequestEvent('toolFc1'),
          credentialResponseEvent(),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1', 'toolFc2']));
      expect(
        vi.mocked(handleFunctionCallsAsync).mock.calls[0][0].functionCallEvent,
      ).toBe(originalCalls);
    });

    it('does not resume a call awaiting a different credential key', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          toolCallEvent(['toolFc1', 'toolFc2']),
          pendingAuthEvent({toolFc1: 'testKey', toolFc2: 'otherKey'}),
          credentialRequestEvent('toolFc1'),
          credentialResponseEvent(),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });

    it('does not resume stale calls from an older request', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          toolCallEvent(['toolFc1', 'staleFc']),
          pendingAuthEvent({staleFc: 'testKey'}),
          pendingAuthEvent({toolFc1: 'testKey'}),
          credentialRequestEvent('toolFc1'),
          credentialResponseEvent(),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });

    it('ignores a requestedAuthConfigs map the client wrote', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          toolCallEvent(['toolFc1', 'toolFc2']),
          pendingAuthEvent(
            {toolFc1: 'testKey', toolFc2: 'testKey'},
            {author: 'user'},
          ),
          credentialRequestEvent('toolFc1'),
          credentialResponseEvent(),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });

    it('does not cascade through a newly added target', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          toolCallEvent(['toolFc1', 'toolFc2', 'toolFc3']),
          pendingAuthEvent({toolFc1: 'testKey', toolFc2: 'testKey'}),
          pendingAuthEvent({toolFc2: 'testKey', toolFc3: 'testKey'}),
          credentialRequestEvent('toolFc1'),
          credentialResponseEvent(),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1', 'toolFc2']));
    });

    it('skips an event whose actions carry no auth map', async () => {
      const originalCalls = createEvent({
        author: 'agent',
        actions: {requestedAuthConfigs: undefined},
        content: {
          parts: [{functionCall: {id: 'toolFc1', name: 'someTool', args: {}}}],
        },
      });
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          originalCalls,
          credentialRequestEvent('toolFc1'),
          credentialResponseEvent(),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });

    it('widens by a toolset auth key without resuming the toolset call', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn([
          toolCallEvent(['toolFc1', 'toolFc2']),
          pendingAuthEvent({toolFc1: 'testKey', toolFc2: 'toolsetKey'}),
          credentialRequestEvent('toolFc1'),
          credentialRequestEvent('_adk_toolset_auth_listing', {
            id: 'fc2',
            credentialKey: 'toolsetKey',
          }),
          credentialResponseEvent({ids: ['fc1', 'fc2']}),
        ]),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1', 'toolFc2']));
    });
  });

  describe('branch scoping', () => {
    beforeEach(() => {
      vi.mocked(handleFunctionCallsAsync).mockClear();
      storeCredential.mockClear();
    });

    it('ignores a credential response raised on a sibling branch', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn(
          [
            toolCallEvent(['toolFc1'], 'root.b@1'),
            credentialRequestEvent('toolFc1', {branch: 'root.b@1'}),
            credentialResponseEvent({branch: 'root.b@1'}),
          ],
          'root.a@1',
        ),
      );

      expect((await generator.next()).done).toBe(true);
      expect(storeCredential).not.toHaveBeenCalled();
    });

    it('honours events on the current branch and on no branch', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn(
          [
            toolCallEvent(['toolFc1']),
            credentialRequestEvent('toolFc1', {branch: 'root.a@1'}),
            credentialResponseEvent({branch: 'root.a@1'}),
          ],
          'root.a@1',
        ),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });

    it('honours an event on an ancestor branch', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn(
          [
            toolCallEvent(['toolFc1'], 'root'),
            credentialRequestEvent('toolFc1', {branch: 'root'}),
            credentialResponseEvent({branch: 'root.a@1'}),
          ],
          'root.a@1',
        ),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });

    it('ignores a sibling branch when widening by credential key', async () => {
      const generator = AUTH_PREPROCESSOR.runAsync(
        contextOn(
          [
            toolCallEvent(['toolFc1', 'toolFc2'], 'root.a@1'),
            pendingAuthEvent(
              {toolFc1: 'testKey', toolFc2: 'testKey'},
              {branch: 'root.b@1'},
            ),
            credentialRequestEvent('toolFc1', {branch: 'root.a@1'}),
            credentialResponseEvent({branch: 'root.a@1'}),
          ],
          'root.a@1',
        ),
      );

      expect((await generator.next()).done).toBe(false);
      expect(resumedFilters()).toEqual(new Set(['toolFc1']));
    });
  });
});
