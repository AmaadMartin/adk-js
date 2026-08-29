/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLogger,
  LiteLlm,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

const API_BASE = 'https://llm.example.com/v1';
const CHAT_COMPLETIONS_URL = `${API_BASE}/chat/completions`;

/** Base64 of `test_image_data`. */
const IMAGE_BASE64 = 'dGVzdF9pbWFnZV9kYXRh';

/** A tool call the buffered fixtures reply with. */
const TOOL_CALL = {
  type: 'function',
  id: 'test_tool_call_id',
  function: {name: 'test_function', arguments: '{"test_arg": "test_value"}'},
};

interface SentToolCall {
  type: string;
  id?: string;
  function: {name?: string; arguments?: string};
}

interface SentMessage {
  role: string;
  content: unknown;
  tool_calls?: SentToolCall[];
  tool_call_id?: string;
}

interface SentTool {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, {type?: string}>;
      required?: string[];
    };
  };
}

interface SentBody {
  model: string;
  messages: SentMessage[];
  tools?: SentTool[];
  stream?: boolean;
  temperature?: number;
  api_version?: string;
}

/** A request carrying one user turn and one declared function. */
function requestWithFunctionDeclaration(): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'Test prompt'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'test_function',
              description: 'Test function description',
              parameters: {
                type: Type.OBJECT,
                properties: {test_arg: {type: Type.STRING}},
              },
            },
          ],
        },
      ],
    },
  };
}

/** A request carrying one user turn and nothing else. */
function simpleRequest(config?: LlmRequest['config']): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'Test prompt'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    config,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status});
}

/** Wraps each payload as one server-sent event frame. */
function sseResponse(payloads: unknown[]): Response {
  const frames = payloads.map(
    (payload) => `data: ${JSON.stringify(payload)}\n\n`,
  );
  return new Response(`${frames.join('')}data: [DONE]\n\n`, {status: 200});
}

/** A buffered reply carrying text and one tool call. */
function bufferedReply(): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Test response',
          tool_calls: [TOOL_CALL],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentInit(fetchMock: ReturnType<typeof stubFetch>) {
  const init = fetchMock.mock.calls[0][1];
  if (!init) {
    expect.fail('fetch was called without a request init');
  }
  return init;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): SentBody {
  return JSON.parse(String(sentInit(fetchMock).body)) as SentBody;
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Headers {
  return new Headers(sentInit(fetchMock).headers);
}

/** Drains a generator into a list. */
async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

describe('LiteLlm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env['LITELLM_API_BASE'];
    delete process.env['LITELLM_API_KEY'];
  });

  describe('constructor', () => {
    it('throws naming both the option and the environment variable', () => {
      expect(() => new LiteLlm({model: 'test_model'})).toThrow(
        /apiBase option or the LITELLM_API_BASE environment variable/,
      );
    });

    it('falls back to LITELLM_API_BASE', async () => {
      process.env['LITELLM_API_BASE'] = API_BASE;
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));

      await collect(
        new LiteLlm({model: 'test_model'}).generateContentAsync(
          simpleRequest(),
        ),
      );

      expect(fetchMock.mock.calls[0][0]).toBe(CHAT_COMPLETIONS_URL);
    });

    it('ignores the environment in a browser, where there is none', () => {
      process.env['LITELLM_API_BASE'] = API_BASE;
      vi.stubGlobal('window', {});

      expect(() => new LiteLlm({model: 'test_model'})).toThrow(
        /apiBase option or the LITELLM_API_BASE environment variable/,
      );
    });

    it('trims trailing slashes from the base URL', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));

      await collect(
        new LiteLlm({
          model: 'test_model',
          apiBase: `${API_BASE}//`,
        }).generateContentAsync(simpleRequest()),
      );

      expect(fetchMock.mock.calls[0][0]).toBe(CHAT_COMPLETIONS_URL);
    });

    it('leaves a base URL that already names the endpoint alone', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));

      await collect(
        new LiteLlm({
          model: 'test_model',
          apiBase: CHAT_COMPLETIONS_URL,
        }).generateContentAsync(simpleRequest()),
      );

      expect(fetchMock.mock.calls[0][0]).toBe(CHAT_COMPLETIONS_URL);
    });
  });

  describe('buffered generation', () => {
    it('sends the conversation and the tools, and converts the reply', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      const responses = await collect(
        llm.generateContentAsync(requestWithFunctionDeclaration()),
      );

      const body = sentBody(fetchMock);
      expect(body.model).toBe('test_model');
      expect(body.messages[0]).toEqual({role: 'user', content: 'Test prompt'});
      expect(body.tools?.[0].function.name).toBe('test_function');
      expect(body.tools?.[0].function.description).toBe(
        'Test function description',
      );
      expect(
        body.tools?.[0].function.parameters.properties['test_arg'].type,
      ).toBe('string');
      expect(body.stream).toBe(false);

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.role).toBe('model');
      expect(responses[0].content?.parts?.[0].text).toBe('Test response');
      expect(responses[0].content?.parts?.[1].functionCall).toEqual({
        id: 'test_tool_call_id',
        name: 'test_function',
        args: {test_arg: 'test_value'},
      });
    });

    it('sends the system instruction as the first message', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await collect(
        llm.generateContentAsync(
          simpleRequest({systemInstruction: 'Test system instruction'}),
        ),
      );

      const body = sentBody(fetchMock);
      expect(body.messages[0]).toEqual({
        role: 'system',
        content: 'Test system instruction',
      });
      expect(body.messages[1]).toEqual({role: 'user', content: 'Test prompt'});
    });

    it('sends a function response as a tool message', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});
      const request = simpleRequest({systemInstruction: 'test instruction'});
      request.contents.push({
        role: 'tool',
        parts: [
          {
            functionResponse: {
              id: 'test_tool_call_id',
              name: 'test_function',
              response: {result: 'test_result'},
            },
          },
        ],
      });

      await collect(llm.generateContentAsync(request));

      expect(sentBody(fetchMock).messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'test_tool_call_id',
        content: '{"result":"test_result"}',
      });
    });

    it('throws when the reply carries no message', async () => {
      stubFetch(jsonResponse({choices: []}));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await expect(
        collect(llm.generateContentAsync(simpleRequest())),
      ).rejects.toThrow('No message in response');
    });

    it('throws on a non-2xx reply, naming the status and the body', async () => {
      stubFetch(new Response('invalid api key', {status: 401}));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await expect(
        collect(llm.generateContentAsync(simpleRequest())),
      ).rejects.toThrow(
        'LiteLlm request to test_model failed with status 401: invalid api key',
      );
    });

    it('forwards the abort signal to fetch', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});
      const controller = new AbortController();

      await collect(
        llm.generateContentAsync(simpleRequest(), false, controller.signal),
      );

      expect(sentInit(fetchMock).signal).toBe(controller.signal);
    });
  });

  describe('additional arguments', () => {
    it('merges extra arguments into the request body', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({
        model: 'test_model',
        apiBase: API_BASE,
        additionalArgs: {temperature: 0.5, api_version: '2024-09-12'},
      });

      await collect(llm.generateContentAsync(simpleRequest()));

      const body = sentBody(fetchMock);
      expect(body.temperature).toBe(0.5);
      expect(body.api_version).toBe('2024-09-12');
    });

    it('never lets extra arguments replace the class-owned fields', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({
        model: 'test_model',
        apiBase: API_BASE,
        additionalArgs: {
          model: 'other_model',
          messages: [{role: 'invalid', content: 'invalid'}],
          tools: [{type: 'function', function: {name: 'invalid'}}],
          stream: true,
        },
      });

      await collect(llm.generateContentAsync(requestWithFunctionDeclaration()));

      const body = sentBody(fetchMock);
      expect(body.model).toBe('test_model');
      expect(body.messages[0]).toEqual({role: 'user', content: 'Test prompt'});
      expect(body.tools?.[0].function.name).toBe('test_function');
      expect(body.stream).toBe(false);
    });
  });

  describe('headers', () => {
    it('sends the api key as a bearer token', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({
        model: 'test_model',
        apiBase: API_BASE,
        apiKey: 'test_key',
      });

      await collect(llm.generateContentAsync(simpleRequest()));

      expect(sentHeaders(fetchMock).get('authorization')).toBe(
        'Bearer test_key',
      );
    });

    it('falls back to LITELLM_API_KEY', async () => {
      process.env['LITELLM_API_KEY'] = 'env_key';
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await collect(llm.generateContentAsync(simpleRequest()));

      expect(sentHeaders(fetchMock).get('authorization')).toBe(
        'Bearer env_key',
      );
    });

    it('sends no authorization header when there is no key', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await collect(llm.generateContentAsync(simpleRequest()));

      expect(sentHeaders(fetchMock).get('authorization')).toBeNull();
    });

    it('merges caller headers but keeps the protocol content type', async () => {
      const fetchMock = stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({
        model: 'test_model',
        apiBase: API_BASE,
        headers: {'X-Tenant': 'acme', 'Content-Type': 'text/plain'},
      });

      await collect(llm.generateContentAsync(simpleRequest()));

      const headers = sentHeaders(fetchMock);
      expect(headers.get('x-tenant')).toBe('acme');
      expect(headers.get('content-type')).toBe('application/json');
    });
  });

  describe('streaming generation', () => {
    it('aggregates text deltas and a split tool call into four responses', async () => {
      const fetchMock = stubFetch(
        sseResponse([
          {choices: [{delta: {role: 'assistant', content: 'zero, '}}]},
          {choices: [{delta: {role: 'assistant', content: 'one, '}}]},
          {choices: [{delta: {role: 'assistant', content: 'two:'}}]},
          {
            choices: [
              {
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      type: 'function',
                      id: 'test_tool_call_id',
                      function: {
                        name: 'test_function',
                        arguments: '{"test_arg": "test_',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {type: 'function', function: {arguments: 'value"}'}},
                  ],
                },
              },
            ],
          },
          {choices: [{delta: {role: 'assistant'}, finish_reason: 'tool_use'}]},
        ]),
      );
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      const responses = await collect(
        llm.generateContentAsync(requestWithFunctionDeclaration(), true),
      );

      expect(sentBody(fetchMock).stream).toBe(true);
      expect(responses).toHaveLength(4);
      expect(responses.slice(0, 3).map((r) => r.partial)).toEqual([
        true,
        true,
        true,
      ]);
      expect(
        responses.slice(0, 3).map((r) => r.content?.parts?.[0].text),
      ).toEqual(['zero, ', 'one, ', 'two:']);
      expect(responses[3].partial).toBe(false);
      expect(responses[3].content?.parts?.[0].functionCall).toEqual({
        id: 'test_tool_call_id',
        name: 'test_function',
        args: {test_arg: 'test_value'},
      });
    });

    it('emits the full text once the turn stops', async () => {
      stubFetch(
        sseResponse([
          {choices: [{delta: {role: 'assistant', content: 'zero, '}}]},
          {choices: [{delta: {role: 'assistant', content: 'one'}}]},
          {choices: [{delta: {role: 'assistant'}, finish_reason: 'stop'}]},
        ]),
      );
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      const responses = await collect(
        llm.generateContentAsync(simpleRequest(), true),
      );

      expect(responses).toHaveLength(3);
      expect(responses[2].partial).toBe(false);
      expect(responses[2].content?.parts?.[0].text).toBe('zero, one');
    });

    it('aggregates a tool call whose name and arguments arrive apart', async () => {
      stubFetch(
        sseResponse([
          {
            choices: [
              {
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      type: 'function',
                      id: 'call_1',
                      function: {name: 'first'},
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {type: 'function', function: {arguments: '{"a": 1}'}},
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {delta: {role: 'assistant'}, finish_reason: 'tool_calls'},
            ],
          },
        ]),
      );
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      const responses = await collect(
        llm.generateContentAsync(simpleRequest(), true),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts?.[0].functionCall).toEqual({
        id: 'call_1',
        name: 'first',
        args: {a: 1},
      });
    });

    it('resets the accumulator between two tool calls', async () => {
      stubFetch(
        sseResponse([
          {
            choices: [
              {
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      type: 'function',
                      id: 'call_1',
                      function: {name: 'first', arguments: '{"a": 1}'},
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      type: 'function',
                      id: 'call_2',
                      function: {name: 'second', arguments: '{"b": 2}'},
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      );
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      const responses = await collect(
        llm.generateContentAsync(simpleRequest(), true),
      );

      expect(responses).toHaveLength(2);
      expect(responses[1].content?.parts?.[0].functionCall).toEqual({
        id: 'call_2',
        name: 'second',
        args: {b: 2},
      });
    });

    it('propagates a JSON parse error from a malformed frame', async () => {
      stubFetch(new Response('data: {not json}\n\n', {status: 200}));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await expect(
        collect(llm.generateContentAsync(simpleRequest(), true)),
      ).rejects.toThrow(SyntaxError);
    });

    it('throws when a streaming reply carries no body', async () => {
      stubFetch(new Response(null, {status: 200}));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await expect(
        collect(llm.generateContentAsync(simpleRequest(), true)),
      ).rejects.toThrow('Streaming response has no body.');
    });
  });

  describe('registration and live connection', () => {
    it('declares no supported models and is not registered', () => {
      expect(LiteLlm.supportedModels).toEqual([]);
      expect(() => LLMRegistry.resolve('test_model')).toThrow(
        'Model test_model not found.',
      );
    });

    it('rejects a live connection', async () => {
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});

      await expect(llm.connect(simpleRequest())).rejects.toThrow(
        'Live connection is not supported for test_model.',
      );
    });
  });

  describe('request log', () => {
    it('logs neither the api key nor the inline media payload', async () => {
      const debugSpy = vi.spyOn(getLogger(), 'debug');
      stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({
        model: 'test_model',
        apiBase: API_BASE,
        apiKey: 'test_key',
      });
      const request = simpleRequest();
      request.contents[0].parts?.push({
        inlineData: {mimeType: 'image/png', data: IMAGE_BASE64},
      });

      await collect(llm.generateContentAsync(request));

      const logged = debugSpy.mock.calls
        .map((call) => call.join(' '))
        .join('\n');
      expect(logged).toContain('Test prompt');
      expect(logged).toContain('image/png');
      expect(logged).not.toContain(IMAGE_BASE64);
      expect(logged).not.toContain('test_key');
    });

    it('logs the system instruction and the declared functions', async () => {
      const debugSpy = vi.spyOn(getLogger(), 'debug');
      stubFetch(jsonResponse(bufferedReply()));
      const llm = new LiteLlm({model: 'test_model', apiBase: API_BASE});
      const request = requestWithFunctionDeclaration();
      request.config = {...request.config, systemInstruction: 'be brief'};

      await collect(llm.generateContentAsync(request));

      const logged = debugSpy.mock.calls
        .map((call) => call.join(' '))
        .join('\n');
      expect(logged).toContain('be brief');
      expect(logged).toContain('test_function');
    });
  });
});
