/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  FinishReason,
  FunctionCallingConfigMode,
  Language,
  Outcome,
  Type,
} from '@google/genai';

import {ChatCompletionsLlm, LlmRequest, LlmResponse} from '@google/adk';

const BASE_URL = 'http://localhost:11434/v1';
const MODEL = 'llama3.1';

/** Builds a minimal LlmRequest with the required bookkeeping fields. */
function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/**
 * Mocks `fetch` to return a non-streaming JSON response. A fresh `Response` is
 * created per call so a body is never read twice.
 */
function mockJsonResponse(data: unknown, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(data), {status})),
    );
}

/**
 * Mocks `fetch` to return a streaming response built from raw SSE lines. A
 * fresh stream is created per call so it can be consumed more than once.
 */
function mockStreamResponse(lines: string[], status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, {status}));
  });
}

/** Serializes a chunk object into an SSE `data:` line. */
function dataLine(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n`;
}

/** Collects every response yielded by generateContentAsync. */
async function collect(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of gen) {
    responses.push(response);
  }
  return responses;
}

/** Returns the JSON payload sent to `fetch`. */
function lastPayload(
  fetchSpy: ReturnType<typeof mockJsonResponse>,
): Record<string, unknown> {
  const init = fetchSpy.mock.lastCall![1]!;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('ChatCompletionsLlm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and config', () => {
    it('constructs and exposes an empty supportedModels list', () => {
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      expect(llm).toBeInstanceOf(ChatCompletionsLlm);
      expect(llm.model).toBe(MODEL);
      expect(ChatCompletionsLlm.supportedModels).toEqual([]);
    });

    it('connect() rejects because live connections are unsupported', async () => {
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await expect(llm.connect(makeRequest())).rejects.toThrowError(
        /does not support live connections/,
      );
    });

    it.each([
      [
        'http://localhost:11434/v1',
        'http://localhost:11434/v1/chat/completions',
      ],
      [
        'http://localhost:11434/v1/',
        'http://localhost:11434/v1/chat/completions',
      ],
      [
        'http://localhost:11434/v1/chat/completions',
        'http://localhost:11434/v1/chat/completions',
      ],
    ])('builds the request URL from baseURL %s', async (baseURL, expected) => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL, model: MODEL});
      await collect(llm.generateContentAsync(makeRequest()));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.lastCall![0]).toBe(expected);
    });

    it('sets auth, content-type, and custom headers, and passes the abort signal', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({
        baseURL: BASE_URL,
        model: MODEL,
        apiKey: 'secret-key',
        headers: {'x-tenant': 'team-a'},
      });
      const controller = new AbortController();
      await collect(
        llm.generateContentAsync(makeRequest(), false, controller.signal),
      );
      const init = fetchSpy.mock.lastCall![1]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer secret-key');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-tenant']).toBe('team-a');
      expect(init.signal).toBe(controller.signal);
      expect(init.method).toBe('POST');
    });

    it('omits the Authorization header when no apiKey is provided', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(llm.generateContentAsync(makeRequest()));
      const headers = fetchSpy.mock.lastCall![1]!.headers as Record<
        string,
        string
      >;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('buildPayload', () => {
    it('constructs a basic payload with a single string-content user message', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(llm.generateContentAsync(makeRequest()));

      const payload = lastPayload(fetchSpy);
      expect(payload['model']).toBe(MODEL);
      expect(payload['stream']).toBe(false);
      const messages = payload['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]['role']).toBe('user');
      expect(messages[0]['content']).toBe('Hello');
    });

    it('uses the request model over the instance model', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(llm.generateContentAsync(makeRequest({model: 'qwen2.5'})));
      expect(lastPayload(fetchSpy)['model']).toBe('qwen2.5');
    });

    it('maps generation config parameters', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            config: {
              temperature: 0.7,
              topP: 0.9,
              maxOutputTokens: 100,
              stopSequences: ['STOP'],
              frequencyPenalty: 0.5,
              presencePenalty: 0.25,
              seed: 42,
              candidateCount: 2,
              responseMimeType: 'application/json',
            },
          }),
        ),
      );
      const payload = lastPayload(fetchSpy);
      expect(payload['temperature']).toBe(0.7);
      expect(payload['top_p']).toBe(0.9);
      expect(payload['max_tokens']).toBe(100);
      expect(payload['stop']).toEqual(['STOP']);
      expect(payload['frequency_penalty']).toBe(0.5);
      expect(payload['presence_penalty']).toBe(0.25);
      expect(payload['seed']).toBe(42);
      expect(payload['n']).toBe(2);
      expect(payload['response_format']).toEqual({type: 'json_object'});
    });

    it('maps responseLogprobs with and without top_logprobs', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});

      await collect(
        llm.generateContentAsync(
          makeRequest({config: {responseLogprobs: true, logprobs: 5}}),
        ),
      );
      let payload = lastPayload(fetchSpy);
      expect(payload['logprobs']).toBe(true);
      expect(payload['top_logprobs']).toBe(5);

      await collect(
        llm.generateContentAsync(
          makeRequest({config: {responseLogprobs: true}}),
        ),
      );
      payload = lastPayload(fetchSpy);
      expect(payload['logprobs']).toBe(true);
      expect(payload['top_logprobs']).toBeUndefined();
    });

    it.each([
      [
        'schema only',
        {type: 'object', properties: {name: {type: 'string'}}},
        undefined,
        {
          type: 'json_schema',
          json_schema: {type: 'object', properties: {name: {type: 'string'}}},
        },
      ],
      [
        'schema and mime (schema wins)',
        {type: 'object', properties: {name: {type: 'string'}}},
        'application/json',
        {
          type: 'json_schema',
          json_schema: {type: 'object', properties: {name: {type: 'string'}}},
        },
      ],
      ['mime only', undefined, 'application/json', {type: 'json_object'}],
    ])(
      'maps response_format: %s',
      async (_name, responseJsonSchema, responseMimeType, expected) => {
        const fetchSpy = mockJsonResponse({
          choices: [{message: {role: 'assistant', content: '{}'}}],
        });
        const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
        await collect(
          llm.generateContentAsync(
            makeRequest({config: {responseJsonSchema, responseMimeType}}),
          ),
        );
        expect(lastPayload(fetchSpy)['response_format']).toEqual(expected);
      },
    );

    it('maps function declarations to tools (parameters, jsonSchema, and none)', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            config: {
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'get_weather',
                      description: 'Get weather',
                      parameters: {
                        type: Type.OBJECT,
                        properties: {location: {type: Type.STRING}},
                      },
                    },
                    {
                      name: 'get_time',
                      parametersJsonSchema: {type: 'object'},
                    },
                    {name: 'no_params'},
                  ],
                },
              ],
            },
          }),
        ),
      );
      const payload = lastPayload(fetchSpy);
      const tools = payload['tools'] as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(3);
      expect((tools[0]['function'] as Record<string, unknown>)['name']).toBe(
        'get_weather',
      );
      expect(
        (tools[0]['function'] as Record<string, unknown>)['parameters'],
      ).toEqual({type: 'OBJECT', properties: {location: {type: 'STRING'}}});
      expect(
        (tools[1]['function'] as Record<string, unknown>)['parameters'],
      ).toEqual({type: 'object'});
      expect(
        (tools[2]['function'] as Record<string, unknown>)['parameters'],
      ).toEqual({});
    });

    it.each([
      [FunctionCallingConfigMode.ANY, 'required'],
      [FunctionCallingConfigMode.NONE, 'none'],
      [FunctionCallingConfigMode.AUTO, 'auto'],
    ])('maps tool_choice for mode %s', async (mode, expected) => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            config: {
              tools: [{functionDeclarations: [{name: 'fn'}]}],
              toolConfig: {functionCallingConfig: {mode}},
            },
          }),
        ),
      );
      expect(lastPayload(fetchSpy)['tool_choice']).toBe(expected);
    });

    it('omits tools when a tool has no function declarations', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(makeRequest({config: {tools: [{}]}})),
      );
      const payload = lastPayload(fetchSpy);
      expect(payload['tools']).toBeUndefined();
      expect(payload['tool_choice']).toBeUndefined();
    });

    it('places the system instruction first, before the user message', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            config: {systemInstruction: 'You are a helpful assistant.'},
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['role']).toBe('system');
      expect(messages[0]['content']).toBe('You are a helpful assistant.');
      expect(messages[1]['role']).toBe('user');
    });

    it.each([
      ['a Part', {text: 'from part'}, 'from part'],
      [
        'a Content (skipping a text-less part)',
        {role: 'system', parts: [{text: 'from '}, {text: 'content'}, {}]},
        'from content',
      ],
      [
        'an array (skipping a text-less part)',
        ['from ', {text: 'array'}, {}],
        'from array',
      ],
    ])(
      'serializes the system instruction from %s',
      async (_name, systemInstruction, expected) => {
        const fetchSpy = mockJsonResponse({
          choices: [{message: {role: 'assistant', content: 'Hi'}}],
        });
        const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
        await collect(
          llm.generateContentAsync(makeRequest({config: {systemInstruction}})),
        );
        const messages = lastPayload(fetchSpy)['messages'] as Array<
          Record<string, unknown>
        >;
        expect(messages[0]['role']).toBe('system');
        expect(messages[0]['content']).toBe(expected);
      },
    );

    it.each([
      ['a Content with no parts', {parts: []}],
      ['a Part with no text', {}],
    ])(
      'skips a system instruction that serializes to empty: %s',
      async (_name, systemInstruction) => {
        const fetchSpy = mockJsonResponse({
          choices: [{message: {role: 'assistant', content: 'Hi'}}],
        });
        const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
        await collect(
          llm.generateContentAsync(makeRequest({config: {systemInstruction}})),
        );
        const messages = lastPayload(fetchSpy)['messages'] as Array<
          Record<string, unknown>
        >;
        expect(messages).toHaveLength(1);
        expect(messages[0]['role']).toBe('user');
      },
    );

    it('handles a content with no parts', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(makeRequest({contents: [{role: 'user'}]})),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]).toEqual({role: 'user'});
    });

    it('encodes multimodal content without double base64 encoding', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'It is an image'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {text: 'What is this?'},
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: 'ZmFrZV9pbWFnZV9ieXRlcw==',
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      const content = messages[0]['content'] as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({type: 'text', text: 'What is this?'});
      expect(content[1]).toEqual({
        type: 'image_url',
        image_url: {url: 'data:image/jpeg;base64,ZmFrZV9pbWFnZV9ieXRlcw=='},
      });
    });

    it('maps image content supplied via fileData.fileUri', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'ok'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: 'https://example.com/image.jpg',
                      mimeType: 'image/jpeg',
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      const content = messages[0]['content'] as Array<Record<string, unknown>>;
      expect(content[0]).toEqual({
        type: 'image_url',
        image_url: {url: 'https://example.com/image.jpg'},
      });
    });

    it('ignores fileData with no fileUri', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'ok'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {role: 'user', parts: [{fileData: {mimeType: 'image/jpeg'}}]},
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['content']).toBeUndefined();
    });

    it('emits assistant tool_calls with content null and a thought signature', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'call_1',
                      name: 'get_weather',
                      args: {location: 'London'},
                    },
                    thoughtSignature: 'SIG',
                  },
                ],
              },
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['role']).toBe('assistant');
      expect(messages[0]['content']).toBeNull();
      const toolCalls = messages[0]['tool_calls'] as Array<
        Record<string, unknown>
      >;
      expect(
        (toolCalls[0]['function'] as Record<string, unknown>)['name'],
      ).toBe('get_weather');
      expect(
        (toolCalls[0]['function'] as Record<string, unknown>)['arguments'],
      ).toBe('{"location":"London"}');
      expect(toolCalls[0]['extra_content']).toEqual({
        google: {thought_signature: 'SIG'},
      });
    });

    it('derives a tool_call id from the function name when absent', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {role: 'model', parts: [{functionCall: {name: 'do_thing'}}]},
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      const toolCalls = messages[0]['tool_calls'] as Array<
        Record<string, unknown>
      >;
      expect(toolCalls[0]['id']).toBe('call_do_thing');
      expect(
        (toolCalls[0]['function'] as Record<string, unknown>)['arguments'],
      ).toBe('{}');
    });

    it('keeps text content alongside tool_calls in the same message', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'model',
                parts: [
                  {text: 'Let me check.'},
                  {functionCall: {id: 'c1', name: 'lookup', args: {}}},
                ],
              },
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['content']).toBe('Let me check.');
      expect(messages[0]['tool_calls']).toBeDefined();
    });

    it('emits a separate tool message for function responses', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 'call_1',
                      name: 'get_weather',
                      response: {temp: 20},
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"temp":20}',
      });
    });

    it('captures refusal text on outbound messages', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});

      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {role: 'model', parts: [{text: '[[REFUSAL]]: I cannot help'}]},
            ],
          }),
        ),
      );
      let messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['refusal']).toBe('I cannot help');
      expect(messages[0]['content']).toBeUndefined();

      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {role: 'model', parts: [{text: 'Sure\n[[REFUSAL]]: never mind'}]},
            ],
          }),
        ),
      );
      messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['refusal']).toBe('never mind');
      expect(messages[0]['content']).toBe('Sure');
    });

    it('skips image parts on non-user (assistant) turns', async () => {
      const warnSpy = vi.spyOn(
        (await import('../../src/utils/logger.js')).logger,
        'warn',
      );
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'model',
                parts: [{inlineData: {mimeType: 'image/png', data: 'abc'}}],
              },
            ],
          }),
        ),
      );
      const messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['content']).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'Image data is not supported for assistant turns.',
      );
    });

    it('warns and skips executable code and code execution results', async () => {
      const warnSpy = vi.spyOn(
        (await import('../../src/utils/logger.js')).logger,
        'warn',
      );
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    executableCode: {
                      code: 'print(1)',
                      language: Language.PYTHON,
                    },
                  },
                  {
                    codeExecutionResult: {
                      outcome: Outcome.OUTCOME_OK,
                      output: '1',
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );
      expect(lastPayload(fetchSpy)['messages']).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Executable code is not supported in the standard Chat Completions API.',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'Code execution result is not supported in the standard Chat ' +
          'Completions API.',
      );
    });

    it('flattens text-only content for Ollama but keeps media arrays', async () => {
      const fetchSpy = mockJsonResponse({
        choices: [{message: {role: 'assistant', content: 'Hi'}}],
      });
      const llm = new ChatCompletionsLlm({
        baseURL: BASE_URL,
        model: MODEL,
        provider: 'ollama',
      });

      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [{role: 'user', parts: [{text: 'just one line'}]}],
          }),
        ),
      );
      let messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['content']).toBe('just one line');

      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {role: 'user', parts: [{text: 'line one'}, {text: 'line two'}]},
            ],
          }),
        ),
      );
      messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(messages[0]['content']).toBe('line one\nline two');

      await collect(
        llm.generateContentAsync(
          makeRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {text: 'What is this?'},
                  {inlineData: {mimeType: 'image/png', data: 'abc'}},
                ],
              },
            ],
          }),
        ),
      );
      messages = lastPayload(fetchSpy)['messages'] as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(messages[0]['content'])).toBe(true);
    });
  });

  describe('non-streaming response mapping', () => {
    it('maps plain assistant text, usage, finish reason, and metadata', async () => {
      mockJsonResponse({
        id: 'chatcmpl-1',
        created: 1234567890,
        object: 'chat.completion',
        service_tier: 'default',
        model: 'llama3.1-instruct',
        choices: [
          {
            message: {role: 'assistant', content: 'Hello there'},
            finish_reason: 'stop',
          },
        ],
        usage: {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30},
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));

      expect(responses).toHaveLength(1);
      const response = responses[0];
      expect(response.content!.role).toBe('model');
      expect(response.content!.parts![0].text).toBe('Hello there');
      expect(response.finishReason).toBe(FinishReason.STOP);
      expect(response.modelVersion).toBe('llama3.1-instruct');
      expect(response.usageMetadata!.promptTokenCount).toBe(10);
      expect(response.usageMetadata!.candidatesTokenCount).toBe(20);
      expect(response.usageMetadata!.totalTokenCount).toBe(30);
      expect(response.customMetadata!['id']).toBe('chatcmpl-1');
      expect(response.customMetadata!['service_tier']).toBe('default');
    });

    it('maps reasoning tokens to thoughtsTokenCount when present', async () => {
      mockJsonResponse({
        choices: [
          {
            message: {role: 'assistant', content: 'Thought hard'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
          completion_tokens_details: {reasoning_tokens: 7},
        },
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));
      expect(responses[0].usageMetadata!.thoughtsTokenCount).toBe(7);
    });

    it('maps a tool_calls response with parsed arguments', async () => {
      mockJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location": "London"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));

      const part = responses[0].content!.parts![0];
      expect(part.functionCall!.name).toBe('get_weather');
      expect(part.functionCall!.args).toEqual({location: 'London'});
      expect(part.functionCall!.id).toBe('call_123');
    });

    it('maps a tool_calls response carrying a thought signature', async () => {
      mockJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {name: 'fn', arguments: '{}'},
                  extra_content: {google: {thought_signature: 'SIG'}},
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));
      expect(responses[0].content!.parts![0].thoughtSignature).toBe('SIG');
    });

    it('maps the deprecated top-level function_call (no id)', async () => {
      mockJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              function_call: {
                name: 'get_weather',
                arguments: '{"location": "London"}',
              },
            },
            finish_reason: 'stop',
          },
        ],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));

      const part = responses[0].content!.parts![0];
      expect(part.functionCall!.name).toBe('get_weather');
      expect(part.functionCall!.args).toEqual({location: 'London'});
      expect(part.functionCall!.id).toBeUndefined();
    });

    it('handles a choice with no message as empty content', async () => {
      mockJsonResponse({choices: [{finish_reason: 'stop'}]});
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));
      expect(responses[0].content!.parts).toEqual([]);
    });

    it('throws on an unsupported tool_call type', async () => {
      mockJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{id: 'c1', type: 'custom', custom: {name: 'x'}}],
            },
          },
        ],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await expect(
        collect(llm.generateContentAsync(makeRequest())),
      ).rejects.toThrowError(/Unsupported tool_call type: custom/);
    });

    it('throws on malformed tool_call arguments JSON', async () => {
      mockJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {name: 'x', arguments: '{bad'},
                },
              ],
            },
          },
        ],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await expect(
        collect(llm.generateContentAsync(makeRequest())),
      ).rejects.toThrowError(/Failed to parse arguments: \{bad/);
    });

    it('throws when no choices are present', async () => {
      mockJsonResponse({choices: []});
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await expect(
        collect(llm.generateContentAsync(makeRequest())),
      ).rejects.toThrowError(/No choices found in response/);
    });

    it.each([
      ['length', FinishReason.MAX_TOKENS],
      ['content_filter', FinishReason.SAFETY],
      ['tool_calls', FinishReason.STOP],
      ['something_else', FinishReason.FINISH_REASON_UNSPECIFIED],
    ])('maps finish_reason %s', async (reason, expected) => {
      mockJsonResponse({
        choices: [
          {message: {role: 'assistant', content: 'x'}, finish_reason: reason},
        ],
      });
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(llm.generateContentAsync(makeRequest()));
      expect(responses[0].finishReason).toBe(expected);
    });

    it('throws with status and body on a non-2xx response', async () => {
      mockJsonResponse({error: 'boom'}, 500);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      await expect(
        collect(llm.generateContentAsync(makeRequest())),
      ).rejects.toThrowError(/failed with status 500/);
    });
  });

  describe('streaming', () => {
    it('accumulates a single tool call across chunks', async () => {
      const meta = {
        id: 'chatcmpl-123',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'gpt-3.5-turbo',
        service_tier: 'default',
      };
      mockStreamResponse([
        dataLine({
          ...meta,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    type: 'function',
                    function: {name: 'get_weather', arguments: ''},
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        dataLine({
          ...meta,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {index: 0, function: {arguments: '{"location": "London"}'}},
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        dataLine({
          ...meta,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {index: 0, function: {arguments: '{"country": "UK"}'}},
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        dataLine({
          ...meta,
          choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}],
          usage: {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30},
        }),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );

      expect(responses).toHaveLength(5);
      expect(responses[0].partial).toBe(true);
      expect(responses[0].content!.parts![0].functionCall!.name).toBe(
        'get_weather',
      );
      expect(responses[0].content!.parts![0].functionCall!.id).toBe('call_123');
      expect(responses[1].content!.parts![0].functionCall!.args).toEqual({
        location: 'London',
      });
      expect(responses[2].content!.parts![0].functionCall!.args).toEqual({
        country: 'UK',
      });
      expect(responses[3].content!.parts).toEqual([]);

      const final = responses[4];
      expect(final.finishReason).toBe(FinishReason.STOP);
      expect(final.content!.parts![0].functionCall!.args).toEqual({
        location: 'London',
        country: 'UK',
      });
      expect(final.modelVersion).toBe('gpt-3.5-turbo');
      expect(final.customMetadata!['id']).toBe('chatcmpl-123');
      expect(final.usageMetadata!.promptTokenCount).toBe(10);
      expect(final.usageMetadata!.candidatesTokenCount).toBe(20);
      expect(final.usageMetadata!.totalTokenCount).toBe(30);
    });

    it('accumulates multiple tool calls independently', async () => {
      mockStreamResponse([
        dataLine({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'func_1', arguments: ''},
                  },
                  {
                    index: 1,
                    id: 'call_2',
                    type: 'function',
                    function: {name: 'func_2', arguments: ''},
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        dataLine({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {index: 0, function: {arguments: '{"arg": 1}'}},
                  {index: 1, function: {arguments: '{"arg": 2}'}},
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        dataLine({
          choices: [{index: 0, finish_reason: 'tool_calls'}],
        }),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );

      expect(responses).toHaveLength(4);
      const parts = responses[responses.length - 1].content!.parts!;
      expect(parts).toHaveLength(2);
      expect(parts[0].functionCall!.name).toBe('func_1');
      expect(parts[0].functionCall!.args).toEqual({arg: 1});
      expect(parts[0].functionCall!.id).toBe('call_1');
      expect(parts[1].functionCall!.name).toBe('func_2');
      expect(parts[1].functionCall!.args).toEqual({arg: 2});
      expect(parts[1].functionCall!.id).toBe('call_2');
    });

    it('handles a streaming tool_call chunk with no function payload', async () => {
      mockStreamResponse([
        dataLine({
          choices: [
            {
              index: 0,
              delta: {tool_calls: [{index: 0, id: 'call_x'}]},
              finish_reason: null,
            },
          ],
        }),
        dataLine({
          choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}],
        }),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      const final = responses[responses.length - 1];
      expect(final.content!.parts![0].functionCall!.id).toBe('call_x');
    });

    it.each([
      [
        'blank and whitespace lines are ignored',
        [
          '\n',
          '   \n',
          dataLine({
            choices: [
              {index: 0, delta: {content: 'Hello'}, finish_reason: null},
            ],
          }),
        ],
      ],
      [
        'a bare [DONE] stops the stream',
        [
          dataLine({
            choices: [
              {index: 0, delta: {content: 'Hello'}, finish_reason: null},
            ],
          }),
          '[DONE]\n',
          dataLine({
            choices: [
              {index: 0, delta: {content: 'World'}, finish_reason: 'stop'},
            ],
          }),
        ],
      ],
      [
        'a padded [DONE] stops the stream',
        [
          dataLine({
            choices: [
              {index: 0, delta: {content: 'Hello'}, finish_reason: null},
            ],
          }),
          '   [DONE]   \n',
          dataLine({
            choices: [
              {index: 0, delta: {content: 'World'}, finish_reason: 'stop'},
            ],
          }),
        ],
      ],
      [
        'a data: [DONE] stops the stream',
        [
          dataLine({
            choices: [
              {index: 0, delta: {content: 'Hello'}, finish_reason: null},
            ],
          }),
          'data: [DONE]\n',
          dataLine({
            choices: [
              {index: 0, delta: {content: 'World'}, finish_reason: 'stop'},
            ],
          }),
        ],
      ],
    ])('parses SSE lines: %s', async (_name, lines) => {
      mockStreamResponse(lines);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].content!.parts![0].text).toBe('Hello');
    });

    it('accumulates a streaming refusal', async () => {
      mockStreamResponse([
        dataLine({
          choices: [{index: 0, delta: {role: 'assistant', content: 'Hello'}}],
        }),
        dataLine({choices: [{index: 0, delta: {refusal: 'I refuse'}}]}),
        dataLine({choices: [{index: 0, delta: {refusal: ' to answer'}}]}),
        dataLine({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );

      expect(responses).toHaveLength(5);
      expect(responses[0].content!.parts![0].text).toBe('Hello');
      expect(responses[1].content!.parts![0].text).toBe(
        '\n[[REFUSAL]]: I refuse',
      );
      expect(responses[2].content!.parts![0].text).toBe(' to answer');
      const final = responses[4];
      expect(final.finishReason).toBe(FinishReason.STOP);
      expect(final.content!.parts![0].text).toBe(
        'Hello\n[[REFUSAL]]: I refuse to answer',
      );
    });

    it('drops content that arrives after a refusal has started', async () => {
      const warnSpy = vi.spyOn(
        (await import('../../src/utils/logger.js')).logger,
        'warn',
      );
      mockStreamResponse([
        dataLine({choices: [{index: 0, delta: {refusal: 'no'}}]}),
        dataLine({choices: [{index: 0, delta: {content: 'ignored'}}]}),
        dataLine({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );

      expect(responses[1].content!.parts).toEqual([]);
      expect(responses[responses.length - 1].content!.parts![0].text).toBe(
        '[[REFUSAL]]: no',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'Received content after refusal has started. Dropping content.',
      );
    });

    it('yields a single partial response for a metadata-only chunk', async () => {
      mockStreamResponse([
        dataLine({
          id: 'meta-1',
          usage: {prompt_tokens: 5, completion_tokens: 6, total_tokens: 11},
        }),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].partial).toBe(true);
      expect(responses[0].usageMetadata!.promptTokenCount).toBe(5);
      expect(responses[0].customMetadata!['id']).toBe('meta-1');
    });

    it('yields nothing for an empty chunk with no choices or metadata', async () => {
      mockStreamResponse([
        '{}\n',
        dataLine({
          choices: [{index: 0, delta: {content: 'Hi'}, finish_reason: null}],
        }),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].content!.parts![0].text).toBe('Hi');
    });

    it('skips a malformed JSON line without aborting the stream', async () => {
      const warnSpy = vi.spyOn(
        (await import('../../src/utils/logger.js')).logger,
        'warn',
      );
      mockStreamResponse([
        'data: not-json\n',
        dataLine({
          choices: [{index: 0, delta: {content: 'Hello'}, finish_reason: null}],
        }),
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].content!.parts![0].text).toBe('Hello');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse JSON chunk'),
      );
    });

    it('processes a trailing line that has no newline terminator', async () => {
      mockStreamResponse([
        `data: ${JSON.stringify({
          choices: [{index: 0, delta: {content: 'Hello'}, finish_reason: null}],
        })}`,
      ]);
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].content!.parts![0].text).toBe('Hello');
    });

    it('yields nothing when the streaming response has no body', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {status: 200}),
      );
      const llm = new ChatCompletionsLlm({baseURL: BASE_URL, model: MODEL});
      const responses = await collect(
        llm.generateContentAsync(makeRequest(), true),
      );
      expect(responses).toEqual([]);
    });
  });
});
