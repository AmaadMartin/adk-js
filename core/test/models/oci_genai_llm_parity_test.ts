/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from adk-python, so that the two implementations can
 * be compared name by name.
 *
 * Source:
 * `adk-python:tests/unittests/integrations/oci/test_oci_genai_llm.py`
 * at ref `main`. Each `it` keeps its original snake_case name. Where adk-js
 * deliberately behaves differently, the test asserts what adk-js does and the
 * comment above it names the divergence.
 */

import {LLMRegistry, LlmRequest, LlmResponse, OciGenAiLlm} from '@google/adk';
import {Type} from '@google/genai';
import type {responses} from 'oci-generativeaiinference';
import {models} from 'oci-generativeaiinference';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  contentToOciMessages,
  functionDeclarationToOciTool,
  ociResponseToLlmResponse,
} from '../../src/models/oci_genai_llm.js';

/** What the provider calls on the OCI client. */
type ChatCall = (request: {
  chatDetails: models.ChatDetails;
}) => Promise<responses.ChatResponse | ReadableStream<Uint8Array> | null>;

const state = vi.hoisted(() => ({
  chatMock: vi.fn<ChatCall>(),
  createdClients: [] as Array<{endpoint: string}>,
  authProviders: [] as string[],
  configFileArgs: [] as Array<{file?: string; profile?: string}>,
}));

// Only the client and the credential providers are faked: the model namespace
// stays real, so the payloads under test are checked against the SDK's own
// types and enums.
vi.mock('oci-generativeaiinference', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('oci-generativeaiinference')>();
  class GenerativeAiInferenceClient {
    endpoint = '';
    chat = state.chatMock;
    constructor() {
      state.createdClients.push(this);
    }
  }
  return {...actual, GenerativeAiInferenceClient};
});

vi.mock('oci-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oci-common')>();
  class ConfigFileAuthenticationDetailsProvider {
    constructor(file?: string, profile?: string) {
      state.authProviders.push('API_KEY');
      state.configFileArgs.push({file, profile});
    }
  }
  class InstancePrincipalsAuthenticationDetailsProviderBuilder {
    async build() {
      state.authProviders.push('INSTANCE_PRINCIPAL');
      return {};
    }
  }
  return {
    ...actual,
    ConfigFileAuthenticationDetailsProvider,
    InstancePrincipalsAuthenticationDetailsProviderBuilder,
    ResourcePrincipalAuthenticationDetailsProvider: {
      builder: () => {
        state.authProviders.push('RESOURCE_PRINCIPAL');
        return {};
      },
    },
  };
});

const MODEL = 'google.gemini-2.5-flash';
const COMPARTMENT_ID = 'ocid1.compartment.oc1..example';
const SERVICE_ENDPOINT =
  'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com';
const CHART_BASE64 = 'Y2hhcnQ=';
const PNG_BASE64 = 'iVBORw0KGgo=';
const PDF_BASE64 = 'JVBERi0xLjQ=';
const OCI_ENV_VARS = [
  'OCI_COMPARTMENT_ID',
  'OCI_SERVICE_ENDPOINT',
  'OCI_ENDPOINT_ID',
];

const encoder = new TextEncoder();

/** The `oci_llm` fixture of the reference module. */
function ociLlm(): OciGenAiLlm {
  return new OciGenAiLlm({
    model: MODEL,
    compartmentId: COMPARTMENT_ID,
    serviceEndpoint: SERVICE_ENDPOINT,
  });
}

/** The `llm_request` fixture of the reference module. */
function llmRequest(): LlmRequest {
  return newRequest({
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config: {systemInstruction: 'You are a helpful assistant.'},
  });
}

function newRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL,
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

async function collect(
  responseStream: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const received: LlmResponse[] = [];
  for await (const response of responseStream) {
    received.push(response);
  }
  return received;
}

/** The `_make_oci_response` helper of the reference module. */
function makeOciResponse(
  options: {
    text?: string;
    toolCalls?: models.ToolCall[];
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  } = {},
): responses.ChatResponse {
  const text = options.text ?? 'Hello from OCI.';
  const content: models.TextContent[] = text ? [{type: 'TEXT', text}] : [];
  const message: models.AssistantMessage = {
    role: 'ASSISTANT',
    content,
    toolCalls: options.toolCalls ?? [],
  };
  const chatResponse: models.GenericChatResponse = {
    apiFormat: 'GENERIC',
    timeCreated: new Date(0),
    choices: [{index: 0, message, finishReason: 'stop'}],
    usage: {
      promptTokens: options.promptTokens ?? 10,
      completionTokens: options.completionTokens ?? 5,
      completionTokensDetails:
        options.reasoningTokens === undefined
          ? undefined
          : {reasoningTokens: options.reasoningTokens},
    },
  };
  return {
    etag: 'etag',
    opcRequestId: 'opc-request-id',
    modelDeprecationInfo: '',
    chatResult: {modelId: MODEL, modelVersion: '1.0', chatResponse},
  };
}

/** The `_make_tool_call_response` helper of the reference module. */
function makeToolCallResponse(
  name: string,
  args: Record<string, unknown>,
): responses.ChatResponse {
  const call: models.FunctionCall = {
    id: 'call_abc123',
    type: 'FUNCTION',
    name,
    arguments: JSON.stringify(args),
  };
  return makeOciResponse({
    text: '',
    toolCalls: [call],
    promptTokens: 20,
    completionTokens: 15,
  });
}

/** The `_make_sse_chunks` helper of the reference module. */
function makeSseChunks(
  textTokens: string[],
  options: {
    toolCalls?: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
    promptTokens?: number;
    completionTokens?: number;
  } = {},
): Array<Record<string, unknown>> {
  const promptTokens = options.promptTokens ?? 10;
  const completionTokens = options.completionTokens ?? 5;
  const chunks: Array<Record<string, unknown>> = textTokens.map((token) => ({
    index: 0,
    message: {role: 'ASSISTANT', content: [{type: 'TEXT', text: token}]},
  }));
  for (const call of options.toolCalls ?? []) {
    chunks.push({
      index: 0,
      message: {
        role: 'ASSISTANT',
        toolCalls: [
          {
            type: 'FUNCTION',
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        ],
      },
    });
  }
  chunks.push({finishReason: 'stop'});
  chunks.push({
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  });
  return chunks;
}

/** A closed stream carrying `payloads` as SSE events, then `[DONE]`. */
function sseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${body}data: [DONE]\n\n`));
      controller.close();
    },
  });
}

function isGenericChatRequest(
  request: models.ChatDetails['chatRequest'],
): request is models.GenericChatRequest {
  return request.apiFormat === 'GENERIC';
}

function isTextContent(block: models.ChatContent): block is models.TextContent {
  return block.type === 'TEXT';
}

function isFunctionDefinition(
  tool: models.ToolDefinition,
): tool is models.FunctionDefinition {
  return tool.type === 'FUNCTION';
}

/** The chat details of the n-th call the provider made to OCI. */
function sentChatDetails(callIndex = 0): models.ChatDetails {
  const call = state.chatMock.mock.calls[callIndex];
  if (!call) {
    expect.fail(`OCI client was called ${state.chatMock.mock.calls.length}x`);
  }
  return call[0].chatDetails;
}

function sentChatRequest(callIndex = 0): models.GenericChatRequest {
  return genericChatRequest(sentChatDetails(callIndex));
}

function genericChatRequest(
  details: models.ChatDetails,
): models.GenericChatRequest {
  const request = details.chatRequest;
  if (!isGenericChatRequest(request)) {
    expect.fail(`OCI request used the ${request.apiFormat} format`);
  }
  return request;
}

/** The service endpoint the provider set on the client it built. */
function sentEndpoint(clientIndex = 0): string {
  const client = state.createdClients[clientIndex];
  if (!client) {
    expect.fail(`${state.createdClients.length} clients were built`);
  }
  return client.endpoint;
}

/** The n-th message of a request the provider sent. */
function messageOf(
  request: models.GenericChatRequest,
  index: number,
): models.Message {
  const message = request.messages?.[index];
  if (!message) {
    expect.fail(
      `OCI request carried ${request.messages?.length ?? 0} messages`,
    );
  }
  return message;
}

/** The n-th message of the request the provider sent. */
function sentMessage(index: number, callIndex = 0): models.Message {
  return messageOf(sentChatRequest(callIndex), index);
}

/** The n-th tool of the request the provider sent. */
function sentTool(index: number, callIndex = 0): models.FunctionDefinition {
  const tool = sentChatRequest(callIndex).tools?.[index];
  if (!tool || !isFunctionDefinition(tool)) {
    expect.fail(`OCI request carried no function tool at ${index}`);
  }
  return tool;
}

/** The text of the first content block of a message. */
function firstText(message: models.Message): string {
  const block = message.content?.[0];
  if (!block || !isTextContent(block) || block.text === undefined) {
    expect.fail('message carries no leading TEXT block');
  }
  return block.text;
}

describe('OciGenAiLlm reference tests', () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    state.chatMock.mockReset();
    state.createdClients.length = 0;
    state.authProviders.length = 0;
    state.configFileArgs.length = 0;
    for (const name of OCI_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedEnv.clear();
  });

  // -------------------------------------------------------------------------
  // supported_models
  //
  // Divergence 5: adk-python exposes `supported_models()`, a classmethod
  // returning `list[str]`. `BaseLlm` in adk-js mandates the static
  // `supportedModels` field, holding regular expressions.
  // -------------------------------------------------------------------------

  describe('supported_models', () => {
    it('test_supported_models_gemini', () => {
      expect(
        OciGenAiLlm.supportedModels.some((pattern) =>
          String(pattern).includes('gemini'),
        ),
      ).toBe(true);
    });

    it('test_supported_models_llama', () => {
      expect(
        OciGenAiLlm.supportedModels.some((pattern) =>
          String(pattern).includes('llama'),
        ),
      ).toBe(true);
    });

    it('test_supported_models_gemma', () => {
      expect(
        OciGenAiLlm.supportedModels.some((pattern) =>
          String(pattern).includes('gemma'),
        ),
      ).toBe(true);
    });

    // Divergence 4: adk-python pre-registers the patterns lazily. `registry.ts`
    // registers eagerly, so the assertion ports unchanged.
    it('test_supported_models_registry', () => {
      expect(LLMRegistry.resolve('google.gemini-2.0-flash-001')).toBe(
        OciGenAiLlm,
      );
      expect(LLMRegistry.resolve('meta.llama-3.1-8b-instruct')).toBe(
        OciGenAiLlm,
      );
      expect(LLMRegistry.resolve('google.gemma-3-27b-it')).toBe(OciGenAiLlm);
    });
  });

  // -------------------------------------------------------------------------
  // _content_to_oci_message
  // -------------------------------------------------------------------------

  describe('_content_to_oci_message', () => {
    it('test_content_to_oci_message_user_text', () => {
      expect(
        contentToOciMessages({role: 'user', parts: [{text: 'Hi there'}]}),
      ).toEqual([{role: 'USER', content: [{type: 'TEXT', text: 'Hi there'}]}]);
    });

    it('test_content_to_oci_message_assistant_text', () => {
      expect(
        contentToOciMessages({role: 'model', parts: [{text: 'I can help.'}]}),
      ).toEqual([
        {
          role: 'ASSISTANT',
          content: [{type: 'TEXT', text: 'I can help.'}],
          toolCalls: undefined,
        },
      ]);
    });

    it('test_content_to_oci_message_multi_part_text', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [{text: 'First'}, {text: 'Second'}],
      });

      expect(messages).toHaveLength(1);
      expect(firstText(messages[0])).toContain('First');
      expect(firstText(messages[0])).toContain('Second');
    });

    it('test_content_to_oci_message_function_call', () => {
      expect(
        contentToOciMessages({
          role: 'model',
          parts: [
            {functionCall: {name: 'get_weather', args: {city: 'Toronto'}}},
          ],
        }),
      ).toEqual([
        {
          role: 'ASSISTANT',
          content: [],
          toolCalls: [
            {
              id: '',
              type: 'FUNCTION',
              name: 'get_weather',
              arguments: '{"city":"Toronto"}',
            },
          ],
        },
      ]);
    });

    it('test_content_to_oci_message_function_response', () => {
      expect(
        contentToOciMessages({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_xyz',
                name: 'get_weather',
                response: {result: 'Sunny, 22°C'},
              },
            },
          ],
        }),
      ).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_xyz',
          content: [{type: 'TEXT', text: '{"result":"Sunny, 22°C"}'}],
        },
      ]);
    });

    /** Media a tool attached to its response follows as its own message. */
    it('test_content_to_oci_message_function_response_with_media', () => {
      expect(
        contentToOciMessages({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_xyz',
                name: 'draw_chart',
                response: {title: 'Revenue'},
                parts: [
                  {inlineData: {mimeType: 'image/png', data: CHART_BASE64}},
                ],
              },
            },
          ],
        }),
      ).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_xyz',
          content: [{type: 'TEXT', text: '{"title":"Revenue"}'}],
        },
        {
          role: 'USER',
          content: [
            {
              type: 'IMAGE',
              imageUrl: {url: `data:image/png;base64,${CHART_BASE64}`},
            },
          ],
        },
      ]);
    });

    it('test_content_to_oci_message_multiple_function_responses', () => {
      expect(
        contentToOciMessages({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_A',
                name: 'get_weather',
                response: {result: 'Sunny, 22°C'},
              },
            },
            {
              functionResponse: {
                id: 'call_B',
                name: 'get_price',
                response: {result: '$150'},
              },
            },
          ],
        }),
      ).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"result":"Sunny, 22°C"}'}],
        },
        {
          role: 'TOOL',
          toolCallId: 'call_B',
          content: [{type: 'TEXT', text: '{"result":"$150"}'}],
        },
      ]);
    });

    it('test_content_to_oci_message_multiple_function_responses_no_id', () => {
      expect(
        contentToOciMessages({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: {result: 'Sunny, 22°C'},
              },
            },
            {functionResponse: {name: 'get_price', response: {result: '$150'}}},
          ],
        }),
      ).toEqual([
        {
          role: 'TOOL',
          toolCallId: '',
          content: [{type: 'TEXT', text: '{"result":"Sunny, 22°C"}'}],
        },
        {
          role: 'TOOL',
          toolCallId: '',
          content: [{type: 'TEXT', text: '{"result":"$150"}'}],
        },
      ]);
    });

    it('test_content_to_oci_message_mixed_tool_and_text', () => {
      expect(
        contentToOciMessages({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_A',
                name: 'get_weather',
                response: {result: 'Sunny, 22°C'},
              },
            },
            {text: 'Here is the weather and some extra text.'},
          ],
        }),
      ).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"result":"Sunny, 22°C"}'}],
        },
        {
          role: 'USER',
          content: [
            {type: 'TEXT', text: 'Here is the weather and some extra text.'},
          ],
        },
      ]);
    });

    // The reference calls `_build_chat_details` directly. adk-js keeps that
    // private, so the payload is read off the OCI client the provider called.
    it('test_build_chat_details_flattens_multiple_tool_messages', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 'call_A',
                      name: 'get_weather',
                      response: {result: 'Sunny, 22°C'},
                    },
                  },
                  {
                    functionResponse: {
                      id: 'call_B',
                      name: 'get_price',
                      response: {result: '$150'},
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );

      expect(sentChatRequest().messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"result":"Sunny, 22°C"}'}],
        },
        {
          role: 'TOOL',
          toolCallId: 'call_B',
          content: [{type: 'TEXT', text: '{"result":"$150"}'}],
        },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // _oci_response_to_llm_response
  // -------------------------------------------------------------------------

  describe('_oci_response_to_llm_response', () => {
    it('test_oci_response_to_llm_response_text', () => {
      const response = ociResponseToLlmResponse(
        makeOciResponse({
          text: 'Here is your answer.',
          promptTokens: 8,
          completionTokens: 4,
        }).chatResult,
      );

      expect(response.content?.role).toBe('model');
      expect(response.content?.parts?.[0].text).toBe('Here is your answer.');
      expect(response.usageMetadata?.promptTokenCount).toBe(8);
      expect(response.usageMetadata?.candidatesTokenCount).toBe(4);
      expect(response.usageMetadata?.totalTokenCount).toBe(12);
    });

    it('test_oci_response_to_llm_response_tool_call', () => {
      const response = ociResponseToLlmResponse(
        makeToolCallResponse('get_weather', {city: 'Chicago'}).chatResult,
      );

      expect(response.content?.role).toBe('model');
      expect(response.content?.parts?.[0].functionCall).toEqual({
        id: 'call_abc123',
        name: 'get_weather',
        args: {city: 'Chicago'},
      });
    });

    it('test_oci_response_to_llm_response_empty_text', () => {
      const response = ociResponseToLlmResponse(
        makeOciResponse({text: ''}).chatResult,
      );

      expect(response.content?.parts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // _function_declaration_to_oci_tool
  // -------------------------------------------------------------------------

  describe('_function_declaration_to_oci_tool', () => {
    it('test_function_declaration_to_oci_tool_no_parameters', () => {
      expect(
        functionDeclarationToOciTool({
          name: 'ping',
          description: 'Check if the service is alive.',
        }),
      ).toEqual({
        type: 'FUNCTION',
        name: 'ping',
        description: 'Check if the service is alive.',
        parameters: {type: 'object', properties: {}},
      });
    });

    // Divergence 8: adk-python dumps each property in the genai/OpenAPI
    // dialect, so a string property reads `{"type": "STRING"}`. adk-js renders
    // it as JSON Schema, which is the dialect the field is declared in.
    it('test_function_declaration_to_oci_tool_with_parameters', () => {
      expect(
        functionDeclarationToOciTool({
          name: 'get_weather',
          description: 'Get weather for a city.',
          parameters: {
            type: Type.OBJECT,
            properties: {city: {type: Type.STRING, description: 'City name'}},
            required: ['city'],
          },
        }),
      ).toEqual({
        type: 'FUNCTION',
        name: 'get_weather',
        description: 'Get weather for a city.',
        parameters: {
          type: 'object',
          properties: {city: {type: 'string', description: 'City name'}},
          required: ['city'],
        },
      });
    });

    it('test_function_declaration_to_oci_tool_json_schema', () => {
      expect(
        functionDeclarationToOciTool({
          name: 'validate',
          description: 'Validates a payload.',
          parametersJsonSchema: {
            type: 'object',
            properties: {value: {type: 'string'}},
            required: ['value'],
          },
        }).parameters,
      ).toEqual({
        type: 'object',
        properties: {value: {type: 'string'}},
        required: ['value'],
      });
    });
  });

  // -------------------------------------------------------------------------
  // OCIGenAILlm.generate_content_async
  // -------------------------------------------------------------------------

  describe('generate_content_async', () => {
    it('test_generate_content_async_text', async () => {
      state.chatMock.mockResolvedValue(
        makeOciResponse({text: 'Hi! I am Gemini on OCI.'}),
      );

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest()),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content?.parts?.[0].text).toBe(
        'Hi! I am Gemini on OCI.',
      );
    });

    it('test_generate_content_async_yields_llm_response', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest()),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content?.role).toBe('model');
    });

    it('test_generate_content_async_with_tools', async () => {
      state.chatMock.mockResolvedValue(
        makeToolCallResponse('get_weather', {city: 'Chicago'}),
      );

      const received = await collect(
        ociLlm().generateContentAsync(
          newRequest({
            model: 'google.gemini-2.0-flash-001',
            contents: [
              {
                role: 'user',
                parts: [{text: 'What is the weather in Chicago?'}],
              },
            ],
            config: {
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'get_weather',
                      description: 'Get weather for a city.',
                      parameters: {
                        type: Type.OBJECT,
                        properties: {city: {type: Type.STRING}},
                        required: ['city'],
                      },
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );

      const call = received[0].content?.parts?.[0].functionCall;
      expect(call?.name).toBe('get_weather');
      expect(call?.args?.['city']).toBe('Chicago');
    });
  });

  // -------------------------------------------------------------------------
  // OCIGenAILlm — streaming (stream=True)
  // -------------------------------------------------------------------------

  describe('streaming', () => {
    /** stream=True yields partial=True chunks then a final partial=False response. */
    it('test_streaming_yields_partial_then_final', async () => {
      state.chatMock.mockResolvedValue(
        sseStream(makeSseChunks(['Hello', ' world', '!'])),
      );

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest(), true),
      );

      const partial = received.filter((response) => response.partial);
      const final = received.filter((response) => !response.partial);
      expect(partial).toHaveLength(3);
      expect(final).toHaveLength(1);
      expect(partial[0].content?.parts?.[0].text).toBe('Hello');
      expect(partial[1].content?.parts?.[0].text).toBe(' world');
      expect(partial[2].content?.parts?.[0].text).toBe('!');
      expect(final[0].content?.parts?.[0].text).toBe('Hello world!');
    });

    /** Final streaming response includes token usage. */
    it('test_streaming_final_has_usage_metadata', async () => {
      state.chatMock.mockResolvedValue(
        sseStream(
          makeSseChunks(['Hi'], {promptTokens: 8, completionTokens: 3}),
        ),
      );

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest(), true),
      );

      const final = received[received.length - 1];
      expect(final.partial).toBe(false);
      expect(final.usageMetadata?.promptTokenCount).toBe(8);
      expect(final.usageMetadata?.candidatesTokenCount).toBe(3);
      expect(final.usageMetadata?.totalTokenCount).toBe(11);
    });

    /** Streaming assembles tool call arguments from delta chunks. */
    it('test_streaming_tool_call', async () => {
      state.chatMock.mockResolvedValue(
        sseStream(
          makeSseChunks([], {
            toolCalls: [
              {
                id: 'call_stream_1',
                name: 'get_weather',
                args: {city: 'Chicago'},
              },
            ],
          }),
        ),
      );

      const received = await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [{role: 'user', parts: [{text: 'Weather in Chicago?'}]}],
          }),
          true,
        ),
      );

      const final = received[received.length - 1];
      expect(final.partial).toBe(false);
      expect(final.content?.parts?.[0].functionCall).toEqual({
        id: 'call_stream_1',
        name: 'get_weather',
        args: {city: 'Chicago'},
      });
    });

    /** Empty SSE chunk list yields a single empty final response. */
    it('test_streaming_empty_chunks', async () => {
      state.chatMock.mockResolvedValue(sseStream([]));

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest(), true),
      );

      expect(received).toHaveLength(1);
      expect(received[0].partial).toBe(false);
    });

    /**
     * stream=False path calls _call_oci, not _call_oci_stream. adk-js has one
     * call path, so what it must not do is ask OCI to stream.
     */
    it('test_nonstreaming_uses_call_oci_not_call_oci_stream', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest(), false),
      );

      expect(state.chatMock).toHaveBeenCalledOnce();
      expect(sentChatRequest().isStream).toBeUndefined();
      expect(sentChatRequest().streamOptions).toBeUndefined();
      expect(received).toHaveLength(1);
    });

    /** stream=True path calls _call_oci_stream, not _call_oci. */
    it('test_streaming_uses_call_oci_stream_not_call_oci', async () => {
      state.chatMock.mockResolvedValue(sseStream(makeSseChunks(['hi'])));

      await collect(ociLlm().generateContentAsync(llmRequest(), true));

      expect(state.chatMock).toHaveBeenCalledOnce();
      expect(sentChatRequest().isStream).toBe(true);
      expect(sentChatRequest().streamOptions).toEqual({isIncludeUsage: true});
    });

    /**
     * Regression guard. The reference pins that adk-python reads the body
     * through `SSEClient.events()` and then closes it. The JS SDK hands back a
     * `ReadableStream` instead (divergence 3), so the equivalent guard is that
     * the provider parses every event before `[DONE]`, stops there, and
     * releases the stream on the way out.
     */
    it('test_call_oci_stream_iterates_sse_via_events_method', async () => {
      const stream = sseStream([
        {
          index: 0,
          message: {role: 'ASSISTANT', content: [{type: 'TEXT', text: 'Hi'}]},
        },
        {finishReason: 'stop'},
        {usage: {promptTokens: 4, completionTokens: 1, totalTokens: 5}},
      ]);
      state.chatMock.mockResolvedValue(stream);

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest(), true),
      );

      expect(received).toHaveLength(2);
      expect(received[0].content?.parts?.[0].text).toBe('Hi');
      expect(received[1].usageMetadata?.totalTokenCount).toBe(5);
      expect(stream.locked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // OCIGenAILlm — concurrent async calls
  // -------------------------------------------------------------------------

  describe('concurrent async calls', () => {
    /** Multiple concurrent generate_content_async calls complete independently. */
    it('test_concurrent_async_calls', async () => {
      const llm = ociLlm();
      state.chatMock.mockImplementation(async ({chatDetails}) => {
        const sent = messageOf(genericChatRequest(chatDetails), 0);
        return makeOciResponse({text: `Response ${firstText(sent)}`});
      });

      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((callId) =>
          collect(
            llm.generateContentAsync(
              newRequest({
                contents: [{role: 'user', parts: [{text: `Call ${callId}`}]}],
              }),
            ),
          ),
        ),
      );

      expect(results).toHaveLength(5);
      results.forEach((received, callId) => {
        expect(received[0].content?.parts?.[0].text).toBe(
          `Response Call ${callId}`,
        );
      });
    });

    /** Multiple concurrent streaming calls complete independently. */
    it('test_concurrent_streaming_calls', async () => {
      const llm = ociLlm();
      state.chatMock.mockImplementation(async ({chatDetails}) => {
        const sent = messageOf(genericChatRequest(chatDetails), 0);
        return sseStream(makeSseChunks([firstText(sent)]));
      });

      const results = await Promise.all(
        [0, 1, 2].map((callId) =>
          collect(
            llm.generateContentAsync(
              newRequest({
                contents: [{role: 'user', parts: [{text: `Stream${callId}`}]}],
              }),
              true,
            ),
          ),
        ),
      );

      results.forEach((received, callId) => {
        const final = received[received.length - 1];
        expect(final.partial).toBe(false);
        expect(final.content?.parts?.[0].text).toContain(`Stream${callId}`);
      });
    });
  });

  // -------------------------------------------------------------------------
  // OCIGenAILlm — configuration & auth
  //
  // adk-python reaches `_resolve_compartment_id`, `_resolve_service_endpoint`
  // and `_build_client` directly. adk-js keeps them private, so each is driven
  // through `generateContentAsync` and read off what the provider sent.
  // -------------------------------------------------------------------------

  describe('configuration and auth', () => {
    it('test_missing_compartment_id_raises', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await expect(
        collect(
          new OciGenAiLlm({model: MODEL}).generateContentAsync(newRequest()),
        ),
      ).rejects.toThrow(/compartmentId/);
    });

    it('test_compartment_id_from_env', async () => {
      process.env['OCI_COMPARTMENT_ID'] = 'ocid1.compartment.example';
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
        }).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().compartmentId).toBe('ocid1.compartment.example');
    });

    it('test_service_endpoint_default', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
        }).generateContentAsync(newRequest()),
      );

      expect(sentEndpoint()).toContain('us-chicago-1');
    });

    it('test_service_endpoint_from_env', async () => {
      const custom =
        'https://inference.generativeai.eu-frankfurt-1.oci.oraclecloud.com';
      process.env['OCI_SERVICE_ENDPOINT'] = custom;
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
        }).generateContentAsync(newRequest()),
      );

      expect(sentEndpoint()).toBe(custom);
    });

    it('test_service_endpoint_explicit_overrides_env', async () => {
      process.env['OCI_SERVICE_ENDPOINT'] = 'https://ignored.example.com';
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: 'https://custom.endpoint.example.com',
        }).generateContentAsync(newRequest()),
      );

      expect(sentEndpoint()).toBe('https://custom.endpoint.example.com');
    });

    it('test_build_client_api_key', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          authType: 'API_KEY',
          authProfile: 'DEFAULT',
          authFileLocation: '~/.oci/config',
        }).generateContentAsync(newRequest()),
      );

      expect(state.authProviders).toEqual(['API_KEY']);
      expect(state.configFileArgs).toEqual([
        {file: '~/.oci/config', profile: 'DEFAULT'},
      ]);
      expect(state.createdClients).toHaveLength(1);
    });

    it('test_build_client_instance_principal', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          authType: 'INSTANCE_PRINCIPAL',
        }).generateContentAsync(newRequest()),
      );

      expect(state.authProviders).toEqual(['INSTANCE_PRINCIPAL']);
      expect(state.configFileArgs).toEqual([]);
      expect(state.createdClients).toHaveLength(1);
    });

    it('test_build_client_resource_principal', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          authType: 'RESOURCE_PRINCIPAL',
        }).generateContentAsync(newRequest()),
      );

      expect(state.authProviders).toEqual(['RESOURCE_PRINCIPAL']);
      expect(state.configFileArgs).toEqual([]);
      expect(state.createdClients).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // OCIGenAILlm._call_oci — verify OCI SDK is called with correct parameters
  // -------------------------------------------------------------------------

  describe('_call_oci parameters', () => {
    it('test_call_oci_passes_model_and_compartment', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: SERVICE_ENDPOINT,
        }).generateContentAsync(newRequest()),
      );

      expect(state.chatMock).toHaveBeenCalledOnce();
      expect(sentChatDetails().compartmentId).toBe(COMPARTMENT_ID);
      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'ON_DEMAND',
        modelId: 'google.gemini-2.0-flash-001',
      });
    });

    it('test_call_oci_passes_system_instruction', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: SERVICE_ENDPOINT,
        }).generateContentAsync(
          newRequest({config: {systemInstruction: 'Be concise.'}}),
        ),
      );

      expect(sentMessage(0)).toEqual({
        role: 'SYSTEM',
        content: [{type: 'TEXT', text: 'Be concise.'}],
      });
    });

    it('test_call_oci_passes_tools', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'google.gemini-2.0-flash-001',
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: SERVICE_ENDPOINT,
        }).generateContentAsync(
          newRequest({
            contents: [{role: 'user', parts: [{text: 'Weather?'}]}],
            config: {
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'get_weather',
                      description: 'Get weather.',
                      parameters: {
                        type: Type.OBJECT,
                        properties: {city: {type: Type.STRING}},
                      },
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );

      expect(sentChatRequest().tools).toHaveLength(1);
      expect(sentTool(0).name).toBe('get_weather');
    });
  });

  // -------------------------------------------------------------------------
  // Serving mode: on-demand (default) vs dedicated (endpoint_id)
  // -------------------------------------------------------------------------

  describe('serving mode', () => {
    it('test_call_oci_uses_on_demand_serving_mode_by_default', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(ociLlm().generateContentAsync(newRequest()));

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'ON_DEMAND',
        modelId: MODEL,
      });
    });

    it('test_call_oci_uses_dedicated_serving_mode_when_endpoint_id_set', async () => {
      const endpointOcid =
        'ocid1.generativeaiendpoint.oc1.us-chicago-1.example';
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'meta.llama-3.1-70b-instruct',
          endpointId: endpointOcid,
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: SERVICE_ENDPOINT,
        }).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'DEDICATED',
        endpointId: endpointOcid,
      });
    });

    it('test_call_oci_uses_dedicated_serving_mode_from_env_var', async () => {
      process.env['OCI_ENDPOINT_ID'] = 'ocid1.generativeaiendpoint.oc1..env';
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'meta.llama-3.1-70b-instruct',
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: SERVICE_ENDPOINT,
        }).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'DEDICATED',
        endpointId: 'ocid1.generativeaiendpoint.oc1..env',
      });
    });

    it('test_explicit_endpoint_id_overrides_env_var', async () => {
      process.env['OCI_ENDPOINT_ID'] = 'ocid1.generativeaiendpoint.oc1..env';
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        new OciGenAiLlm({
          model: 'meta.llama-3.1-70b-instruct',
          endpointId: 'ocid1.generativeaiendpoint.oc1..explicit',
          compartmentId: COMPARTMENT_ID,
          serviceEndpoint: SERVICE_ENDPOINT,
        }).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'DEDICATED',
        endpointId: 'ocid1.generativeaiendpoint.oc1..explicit',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Sampling parameters and max_output_tokens passthrough
  // -------------------------------------------------------------------------

  describe('sampling parameters', () => {
    it('test_call_oci_passes_sampling_params', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            config: {
              maxOutputTokens: 128,
              temperature: 0.7,
              topP: 0.9,
              topK: 40,
              frequencyPenalty: 0.1,
              presencePenalty: 0.2,
              seed: 42,
              stopSequences: ['END', 'STOP'],
            },
          }),
        ),
      );

      const request = sentChatRequest();
      expect(request.maxTokens).toBe(128);
      expect(request.temperature).toBe(0.7);
      expect(request.topP).toBe(0.9);
      expect(request.topK).toBe(40);
      expect(request.frequencyPenalty).toBe(0.1);
      expect(request.presencePenalty).toBe(0.2);
      expect(request.seed).toBe(42);
      expect(request.stop).toEqual(['END', 'STOP']);
    });

    it('test_call_oci_omits_unset_sampling_params', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(ociLlm().generateContentAsync(newRequest()));

      const request = sentChatRequest();
      expect(request.temperature).toBeUndefined();
      expect(request.topP).toBeUndefined();
      expect(request.topK).toBeUndefined();
      expect(request.stop).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Multimodal content
  //
  // Divergence 1: `Blob.data` is `bytes` in adk-python and a base64 string in
  // `@google/genai`, so the port must not encode it a second time.
  // -------------------------------------------------------------------------

  describe('multimodal content', () => {
    it('test_inline_image_becomes_image_content_with_data_url', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {text: 'What is this?'},
                  {inlineData: {mimeType: 'image/png', data: PNG_BASE64}},
                ],
              },
            ],
          }),
        ),
      );

      expect(sentMessage(0).content).toEqual([
        {type: 'TEXT', text: 'What is this?'},
        {
          type: 'IMAGE',
          imageUrl: {url: `data:image/png;base64,${PNG_BASE64}`},
        },
      ]);
    });

    it('test_file_data_audio_becomes_audio_content', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: 'https://example.com/clip.mp3',
                      mimeType: 'audio/mpeg',
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );

      expect(sentMessage(0).content).toEqual([
        {type: 'AUDIO', audioUrl: {url: 'https://example.com/clip.mp3'}},
      ]);
    });

    it('test_inline_pdf_becomes_document_content', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {inlineData: {mimeType: 'application/pdf', data: PDF_BASE64}},
                ],
              },
            ],
          }),
        ),
      );

      expect(sentMessage(0).content).toEqual([
        {
          type: 'DOCUMENT',
          documentUrl: {url: `data:application/pdf;base64,${PDF_BASE64}`},
        },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Response format / structured output
  // -------------------------------------------------------------------------

  describe('response format', () => {
    it('test_response_schema_emits_json_schema_response_format', async () => {
      const schema = {
        title: 'Weather',
        type: 'object',
        properties: {city: {type: 'string'}, temp_c: {type: 'number'}},
        required: ['city', 'temp_c'],
      };
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [{role: 'user', parts: [{text: 'Chicago weather?'}]}],
            config: {
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
        ),
      );

      expect(sentChatRequest().responseFormat).toEqual({
        type: 'JSON_SCHEMA',
        jsonSchema: {
          name: 'Weather',
          description: undefined,
          schema,
          isStrict: true,
        },
      });
    });

    it('test_response_mime_type_only_emits_json_object_format', async () => {
      state.chatMock.mockResolvedValue(makeOciResponse());

      await collect(
        ociLlm().generateContentAsync(
          newRequest({
            contents: [{role: 'user', parts: [{text: 'JSON please'}]}],
            config: {responseMimeType: 'application/json'},
          }),
        ),
      );

      expect(sentChatRequest().responseFormat).toEqual({type: 'JSON_OBJECT'});
    });
  });

  // -------------------------------------------------------------------------
  // Reasoning-token surfacing
  // -------------------------------------------------------------------------

  describe('reasoning tokens', () => {
    it('test_nonstreaming_surfaces_reasoning_tokens', () => {
      const response = ociResponseToLlmResponse(
        makeOciResponse({
          promptTokens: 10,
          completionTokens: 5,
          reasoningTokens: 42,
        }).chatResult,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(42);
    });

    it('test_streaming_surfaces_reasoning_tokens', async () => {
      const chunks = makeSseChunks(['Hi'], {
        promptTokens: 8,
        completionTokens: 3,
      });
      const last = chunks[chunks.length - 1] as {
        usage: Record<string, unknown>;
      };
      last.usage['completionTokensDetails'] = {reasoningTokens: 17};
      state.chatMock.mockResolvedValue(sseStream(chunks));

      const received = await collect(
        ociLlm().generateContentAsync(llmRequest(), true),
      );

      const final = received[received.length - 1];
      expect(final.partial).toBe(false);
      expect(final.usageMetadata?.thoughtsTokenCount).toBe(17);
    });
  });
});
