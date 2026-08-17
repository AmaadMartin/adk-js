/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import type {responses} from 'oci-generativeaiinference';
import {models} from 'oci-generativeaiinference';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  OciGenAiLlm,
  OciGenAiLlmParams,
} from '@google/adk';

import {
  buildResponseFormat,
  contentToOciMessages,
  functionDeclarationToOciTool,
  mediaBlocksForPart,
  ociResponseToLlmResponse,
  toOciRole,
} from '../../src/models/oci_genai_llm.js';

/** What the provider calls on the OCI client. */
type ChatCall = (request: {
  chatDetails: models.ChatDetails;
}) => Promise<responses.ChatResponse | ReadableStream<Uint8Array> | null>;

const state = vi.hoisted(() => ({
  chatMock: vi.fn<ChatCall>(),
  createdClients: [] as Array<{endpoint: string; authParams: unknown}>,
  authProviders: [] as string[],
  configFileArgs: [] as Array<{file?: string; profile?: string}>,
  failNextAuth: false,
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
    constructor(readonly authParams: unknown) {
      state.createdClients.push(this);
    }
  }
  return {...actual, GenerativeAiInferenceClient};
});

vi.mock('oci-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oci-common')>();
  class ConfigFileAuthenticationDetailsProvider {
    constructor(file?: string, profile?: string) {
      if (state.failNextAuth) {
        state.failNextAuth = false;
        throw new Error('config file is unreadable');
      }
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
const ENDPOINT_ID = 'ocid1.generativeaiendpoint.oc1..explicit';
const PNG_BASE64 = 'iVBORw0KGgo=';

const encoder = new TextEncoder();

function newLlm(overrides: Partial<OciGenAiLlmParams> = {}): OciGenAiLlm {
  return new OciGenAiLlm({
    model: MODEL,
    compartmentId: COMPARTMENT_ID,
    serviceEndpoint: SERVICE_ENDPOINT,
    ...overrides,
  });
}

function newRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL,
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
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

function textContent(text: string): models.TextContent {
  return {type: 'TEXT', text};
}

function functionCall(
  name: string,
  args: Record<string, unknown>,
  id = 'call_abc123',
): models.FunctionCall {
  return {id, type: 'FUNCTION', name, arguments: JSON.stringify(args)};
}

function chatResponse(options: {
  text?: string;
  toolCalls?: models.ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}): responses.ChatResponse {
  const message: models.AssistantMessage = {
    role: 'ASSISTANT',
    content: options.text === undefined ? [] : [textContent(options.text)],
    toolCalls: options.toolCalls,
  };
  const generic: models.GenericChatResponse = {
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
    chatResult: {modelId: MODEL, modelVersion: '1.0', chatResponse: generic},
  };
}

function textChunk(text: string) {
  return {
    index: 0,
    message: {role: 'ASSISTANT', content: [{type: 'TEXT', text}]},
  };
}

function toolChunk(delta: {
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
}) {
  return {index: 0, message: {role: 'ASSISTANT', toolCalls: [delta]}};
}

function usageChunk(
  promptTokens: number,
  completionTokens: number,
  reasoningTokens?: number,
) {
  return {
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      completionTokensDetails:
        reasoningTokens === undefined ? undefined : {reasoningTokens},
    },
  };
}

/** A closed stream carrying `payloads` as SSE events, then `[DONE]`. */
function sseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('');
  return rawStream(`${body}data: [DONE]\n\n`);
}

function rawStream(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

function isGenericChatRequest(
  request: models.ChatDetails['chatRequest'],
): request is models.GenericChatRequest {
  return request.apiFormat === 'GENERIC';
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
  const request = sentChatDetails(callIndex).chatRequest;
  if (!isGenericChatRequest(request)) {
    expect.fail(`OCI request used the ${request.apiFormat} format`);
  }
  return request;
}

describe('OciGenAiLlm', () => {
  beforeEach(() => {
    state.chatMock.mockReset();
    state.createdClients.length = 0;
    state.authProviders.length = 0;
    state.configFileArgs.length = 0;
    state.failNextAuth = false;
  });

  afterEach(() => {
    delete process.env['OCI_COMPARTMENT_ID'];
    delete process.env['OCI_SERVICE_ENDPOINT'];
    delete process.env['OCI_ENDPOINT_ID'];
  });

  describe('registry', () => {
    it.each([
      'meta.llama-3.1-8b-instruct',
      'google.gemini-2.0-flash-001',
      'google.gemma-3-27b-it',
      'xai.grok-4',
      'mistralai.mistral-large',
      'mistralai.mixtral-8x7b',
      'nvidia.llama-3.3-nemotron-super-49b',
    ])('resolves %s', (model) => {
      expect(LLMRegistry.resolve(model)).toBe(OciGenAiLlm);
    });

    it('builds an instance from a model name alone', () => {
      expect(LLMRegistry.newLlm('google.gemini-2.5-flash')).toBeInstanceOf(
        OciGenAiLlm,
      );
    });

    it('leaves the bare Gemini model names to the Gemini provider', () => {
      expect(LLMRegistry.resolve('gemini-2.5-flash')).not.toBe(OciGenAiLlm);
    });
  });

  describe('toOciRole', () => {
    it.each(['model', 'assistant'])('maps %s to ASSISTANT', (role) => {
      expect(toOciRole(role)).toBe('ASSISTANT');
    });

    it.each(['user', undefined])('maps %s to USER', (role) => {
      expect(toOciRole(role)).toBe('USER');
    });
  });

  describe('contentToOciMessages', () => {
    it('maps user text to a user message', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [{text: 'Hi there'}],
      });

      expect(messages).toEqual([
        {role: 'USER', content: [{type: 'TEXT', text: 'Hi there'}]},
      ]);
    });

    it('maps model text to an assistant message', () => {
      const messages = contentToOciMessages({
        role: 'model',
        parts: [{text: 'I can help.'}],
      });

      expect(messages).toEqual([
        {role: 'ASSISTANT', content: [{type: 'TEXT', text: 'I can help.'}]},
      ]);
    });

    it('joins several text parts with a newline', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [{text: 'First'}, {text: 'Second'}],
      });

      expect(messages).toEqual([
        {role: 'USER', content: [{type: 'TEXT', text: 'First\nSecond'}]},
      ]);
    });

    it('maps a function call to an assistant tool call', () => {
      const messages = contentToOciMessages({
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_1',
              name: 'get_weather',
              args: {city: 'Toronto'},
            },
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'ASSISTANT',
          content: [],
          toolCalls: [
            {
              id: 'call_1',
              type: 'FUNCTION',
              name: 'get_weather',
              arguments: '{"city":"Toronto"}',
            },
          ],
        },
      ]);
    });

    it('defaults a function call without arguments to an empty object', () => {
      const messages = contentToOciMessages({
        role: 'model',
        parts: [{functionCall: {name: 'ping'}}],
      });

      expect(messages).toEqual([
        {
          role: 'ASSISTANT',
          content: [],
          toolCalls: [
            {id: '', type: 'FUNCTION', name: 'ping', arguments: '{}'},
          ],
        },
      ]);
    });

    it('maps a function response to a tool message', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_xyz',
              name: 'get_weather',
              response: {result: 'Sunny, 22C'},
            },
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_xyz',
          content: [{type: 'TEXT', text: '{"result":"Sunny, 22C"}'}],
        },
      ]);
    });

    it('keeps the order and the ids of several function responses', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [
          {functionResponse: {id: 'call_A', name: 'w', response: {r: 1}}},
          {functionResponse: {id: 'call_B', name: 'p', response: {r: 2}}},
        ],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"r":1}'}],
        },
        {
          role: 'TOOL',
          toolCallId: 'call_B',
          content: [{type: 'TEXT', text: '{"r":2}'}],
        },
      ]);
    });

    it('uses an empty tool call id when the response carries none', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [
          {functionResponse: {name: 'w', response: {result: 'Sunny'}}},
          {functionResponse: {name: 'p', response: {result: '$150'}}},
        ],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: '',
          content: [{type: 'TEXT', text: '{"result":"Sunny"}'}],
        },
        {
          role: 'TOOL',
          toolCallId: '',
          content: [{type: 'TEXT', text: '{"result":"$150"}'}],
        },
      ]);
    });

    it('defaults a function response without a payload to an empty object', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [{functionResponse: {id: 'call_A', name: 'w'}}],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{}'}],
        },
      ]);
    });

    it('appends the media of a function response as a user message', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_A',
              name: 'chart',
              response: {ok: true},
              parts: [{inlineData: {mimeType: 'image/png', data: PNG_BASE64}}],
            },
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"ok":true}'}],
        },
        {
          role: 'USER',
          content: [
            {
              type: 'IMAGE',
              imageUrl: {url: `data:image/png;base64,${PNG_BASE64}`},
            },
          ],
        },
      ]);
    });

    it('emits both a tool message and a user message for a mixed content', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [
          {functionResponse: {id: 'call_A', name: 'w', response: {r: 1}}},
          {text: 'Here is the weather.'},
        ],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"r":1}'}],
        },
        {
          role: 'USER',
          content: [{type: 'TEXT', text: 'Here is the weather.'}],
        },
      ]);
    });

    it('does not append an empty user message after a tool call', () => {
      const messages = contentToOciMessages({
        role: 'user',
        parts: [
          {functionResponse: {id: 'call_A', name: 'w', response: {r: 1}}},
          {functionCall: {id: 'call_B', name: 'w', args: {}}},
        ],
      });

      expect(messages).toEqual([
        {
          role: 'TOOL',
          toolCallId: 'call_A',
          content: [{type: 'TEXT', text: '{"r":1}'}],
        },
      ]);
    });

    it('maps a content with no parts to an empty user message', () => {
      expect(contentToOciMessages({role: 'user'})).toEqual([
        {role: 'USER', content: []},
      ]);
    });
  });

  describe('mediaBlocksForPart', () => {
    it('wraps inline bytes in a data URL without re-encoding them', () => {
      const blocks = mediaBlocksForPart({
        inlineData: {mimeType: 'image/png', data: PNG_BASE64},
      });

      expect(blocks).toEqual([
        {
          type: 'IMAGE',
          imageUrl: {url: `data:image/png;base64,${PNG_BASE64}`},
        },
      ]);
    });

    it('falls back to an octet-stream mime type for untyped inline bytes', () => {
      const blocks = mediaBlocksForPart({inlineData: {data: 'AAA='}});

      expect(blocks).toEqual([
        {
          type: 'DOCUMENT',
          documentUrl: {url: 'data:application/octet-stream;base64,AAA='},
        },
      ]);
    });

    it.each([
      ['audio/mpeg', 'AUDIO', 'audioUrl'],
      ['video/mp4', 'VIDEO', 'videoUrl'],
      ['application/pdf', 'DOCUMENT', 'documentUrl'],
      ['image/jpeg', 'IMAGE', 'imageUrl'],
    ])('maps %s to %s', (mimeType, type, urlField) => {
      const blocks = mediaBlocksForPart({
        fileData: {fileUri: 'https://example.com/file', mimeType},
      });

      expect(blocks).toEqual([
        {type, [urlField]: {url: 'https://example.com/file'}},
      ]);
    });

    it('treats an unknown mime type as a document', () => {
      const blocks = mediaBlocksForPart({
        fileData: {fileUri: 'https://example.com/file'},
      });

      expect(blocks).toEqual([
        {type: 'DOCUMENT', documentUrl: {url: 'https://example.com/file'}},
      ]);
    });

    it('returns nothing for a part that carries no media', () => {
      expect(mediaBlocksForPart({fileData: {mimeType: 'image/png'}})).toEqual(
        [],
      );
    });
  });

  describe('functionDeclarationToOciTool', () => {
    it('defaults a declaration without parameters to an empty schema', () => {
      const tool = functionDeclarationToOciTool({
        name: 'ping',
        description: 'Check if the service is alive.',
      });

      expect(tool).toEqual({
        type: 'FUNCTION',
        name: 'ping',
        description: 'Check if the service is alive.',
        parameters: {type: 'object', properties: {}},
      });
    });

    it('renders genai parameters as JSON Schema', () => {
      const tool = functionDeclarationToOciTool({
        name: 'get_weather',
        parameters: {
          type: Type.OBJECT,
          properties: {
            city: {type: Type.STRING, description: 'City name'},
          },
          required: ['city'],
        },
      });

      expect(tool).toEqual({
        type: 'FUNCTION',
        name: 'get_weather',
        description: '',
        parameters: {
          type: 'object',
          properties: {city: {type: 'string', description: 'City name'}},
          required: ['city'],
        },
      });
    });

    it('omits required when the declaration lists no required parameter', () => {
      const tool = functionDeclarationToOciTool({
        name: 'get_weather',
        parameters: {
          type: Type.OBJECT,
          properties: {city: {type: Type.STRING}},
        },
      });

      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {city: {type: 'string'}},
      });
    });

    it('ignores an empty JSON Schema declaration', () => {
      const tool = functionDeclarationToOciTool({
        name: 'ping',
        parametersJsonSchema: null,
      });

      expect(tool.parameters).toEqual({type: 'object', properties: {}});
    });

    it('passes a JSON Schema declaration through untouched', () => {
      const parametersJsonSchema = {
        type: 'object',
        properties: {value: {type: 'string'}},
        required: ['value'],
      };

      const tool = functionDeclarationToOciTool({
        name: 'validate',
        description: 'Validates a payload.',
        parametersJsonSchema,
      });

      expect(tool.parameters).toEqual(parametersJsonSchema);
    });
  });

  describe('buildResponseFormat', () => {
    it('renders a response schema as a strict JSON schema format', () => {
      const format = buildResponseFormat({
        responseMimeType: 'application/json',
        responseSchema: {
          title: 'Weather',
          description: 'A forecast.',
          type: Type.OBJECT,
          properties: {city: {type: Type.STRING}},
          required: ['city'],
        },
      });

      expect(format).toEqual({
        type: 'JSON_SCHEMA',
        jsonSchema: {
          name: 'Weather',
          description: 'A forecast.',
          schema: {
            title: 'Weather',
            description: 'A forecast.',
            type: 'object',
            properties: {city: {type: 'string'}},
            required: ['city'],
          },
          isStrict: true,
        },
      });
    });

    it('names an untitled response schema "response"', () => {
      const format = buildResponseFormat({
        responseSchema: {type: Type.OBJECT},
      });

      expect(format).toEqual({
        type: 'JSON_SCHEMA',
        jsonSchema: {
          name: 'response',
          description: undefined,
          schema: {type: 'object'},
          isStrict: true,
        },
      });
    });

    it('asks for a JSON object when only the mime type is set', () => {
      expect(
        buildResponseFormat({responseMimeType: 'application/json'}),
      ).toEqual({type: 'JSON_OBJECT'});
    });

    it('asks for text when the mime type is text/plain', () => {
      expect(buildResponseFormat({responseMimeType: 'text/plain'})).toEqual({
        type: 'TEXT',
      });
    });

    it('returns nothing when the request asks for no format', () => {
      expect(buildResponseFormat({})).toBeUndefined();
      expect(
        buildResponseFormat({responseMimeType: 'text/html'}),
      ).toBeUndefined();
    });
  });

  describe('ociResponseToLlmResponse', () => {
    it('maps text and token usage', () => {
      const response = ociResponseToLlmResponse(
        chatResponse({
          text: 'Here is your answer.',
          promptTokens: 8,
          completionTokens: 4,
        }).chatResult,
      );

      expect(response.content).toEqual({
        role: 'model',
        parts: [{text: 'Here is your answer.'}],
      });
      expect(response.usageMetadata).toEqual({
        promptTokenCount: 8,
        candidatesTokenCount: 4,
        totalTokenCount: 12,
        thoughtsTokenCount: undefined,
      });
    });

    it('maps a tool call, parsing its arguments', () => {
      const response = ociResponseToLlmResponse(
        chatResponse({
          toolCalls: [functionCall('get_weather', {city: 'Chicago'})],
        }).chatResult,
      );

      expect(response.content?.parts).toEqual([
        {
          functionCall: {
            id: 'call_abc123',
            name: 'get_weather',
            args: {city: 'Chicago'},
          },
        },
      ]);
    });

    it('falls back to empty arguments when a tool call is not valid JSON', () => {
      const malformed: models.FunctionCall = {
        id: 'call_1',
        type: 'FUNCTION',
        name: 'f',
        arguments: '{oops',
      };
      const response = ociResponseToLlmResponse(
        chatResponse({toolCalls: [malformed]}).chatResult,
      );

      expect(response.content?.parts).toEqual([
        {functionCall: {id: 'call_1', name: 'f', args: {}}},
      ]);
    });

    it('defaults a tool call that carries no arguments to an empty object', () => {
      const bare: models.FunctionCall = {
        id: 'call_1',
        type: 'FUNCTION',
        name: 'ping',
      };
      const response = ociResponseToLlmResponse(
        chatResponse({toolCalls: [bare]}).chatResult,
      );

      expect(response.content?.parts).toEqual([
        {functionCall: {id: 'call_1', name: 'ping', args: {}}},
      ]);
    });

    it('skips a tool call that is not a function call', () => {
      const response = ociResponseToLlmResponse(
        chatResponse({
          text: 'done',
          toolCalls: [{id: 'call_1', type: 'SOMETHING_ELSE'}],
        }).chatResult,
      );

      expect(response.content?.parts).toEqual([{text: 'done'}]);
    });

    it('skips a content block that carries no text', () => {
      const result = chatResponse({text: ''}).chatResult;
      const generic = result.chatResponse;
      if (!('choices' in generic)) {
        expect.fail('fixture is not a generic chat response');
      }
      generic.choices[0].message.content = [{type: 'IMAGE'}, textContent('')];

      expect(ociResponseToLlmResponse(result).content?.parts).toEqual([]);
    });

    it('returns no parts when the model produced no choice', () => {
      const result = chatResponse({}).chatResult;
      const generic = result.chatResponse;
      if (!('choices' in generic)) {
        expect.fail('fixture is not a generic chat response');
      }
      generic.choices = [];

      expect(ociResponseToLlmResponse(result).content?.parts).toEqual([]);
    });

    it('surfaces reasoning tokens', () => {
      const response = ociResponseToLlmResponse(
        chatResponse({text: 'hi', reasoningTokens: 42}).chatResult,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(42);
    });

    it('rejects a response that is not in the generic chat format', () => {
      const cohere: models.CohereChatResponse = {
        apiFormat: 'COHERE',
        text: 'hi',
        finishReason: models.CohereChatResponse.FinishReason.Complete,
      };

      expect(() =>
        ociResponseToLlmResponse({
          modelId: MODEL,
          modelVersion: '1.0',
          chatResponse: cohere,
        }),
      ).toThrow(/COHERE/);
    });
  });

  describe('generateContentAsync, without streaming', () => {
    it('yields exactly one response', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'Hi from OCI.'}));

      const responses = await collect(
        newLlm().generateContentAsync(newRequest()),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts).toEqual([{text: 'Hi from OCI.'}]);
      expect(responses[0].partial).toBeUndefined();
    });

    it('does not ask OCI to stream', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(newLlm().generateContentAsync(newRequest()));

      expect(sentChatRequest().isStream).toBeUndefined();
      expect(sentChatRequest().streamOptions).toBeUndefined();
    });

    it('sends the model, the compartment and the on-demand serving mode', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(newLlm().generateContentAsync(newRequest()));

      expect(sentChatDetails().compartmentId).toBe(COMPARTMENT_ID);
      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'ON_DEMAND',
        modelId: MODEL,
      });
      expect(sentChatRequest().maxTokens).toBe(2048);
    });

    it('sends a system instruction as a leading system message', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
          newRequest({config: {systemInstruction: 'Be concise.'}}),
        ),
      );

      expect(sentChatRequest().messages?.[0]).toEqual({
        role: 'SYSTEM',
        content: [{type: 'TEXT', text: 'Be concise.'}],
      });
    });

    it('sends the text of a Content system instruction', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
          newRequest({
            config: {
              systemInstruction: {
                parts: [{text: 'Be concise.'}, {text: 'Be kind.'}],
              },
            },
          }),
        ),
      );

      expect(sentChatRequest().messages?.[0]).toEqual({
        role: 'SYSTEM',
        content: [{type: 'TEXT', text: 'Be concise.\nBe kind.'}],
      });
    });

    it('sends no system message when the instruction holds no text', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
          newRequest({config: {systemInstruction: {parts: []}}}),
        ),
      );

      expect(sentChatRequest().messages).toEqual([
        {role: 'USER', content: [{type: 'TEXT', text: 'Hello'}]},
      ]);
    });

    it('flattens several tool results into one message list', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
          newRequest({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {id: 'call_A', name: 'w', response: {}},
                  },
                  {
                    functionResponse: {id: 'call_B', name: 'p', response: {}},
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
          content: [{type: 'TEXT', text: '{}'}],
        },
        {
          role: 'TOOL',
          toolCallId: 'call_B',
          content: [{type: 'TEXT', text: '{}'}],
        },
      ]);
    });

    it('sends the function declarations of the first tool', async () => {
      state.chatMock.mockResolvedValue(
        chatResponse({
          toolCalls: [functionCall('get_weather', {city: 'Chicago'})],
        }),
      );

      const responses = await collect(
        newLlm().generateContentAsync(
          newRequest({
            config: {
              tools: [
                {
                  functionDeclarations: [
                    {name: 'get_weather', description: 'Get weather.'},
                  ],
                },
              ],
            },
          }),
        ),
      );

      expect(sentChatRequest().tools).toEqual([
        {
          type: 'FUNCTION',
          name: 'get_weather',
          description: 'Get weather.',
          parameters: {type: 'object', properties: {}},
        },
      ]);
      expect(responses[0].content?.parts?.[0].functionCall?.args).toEqual({
        city: 'Chicago',
      });
    });

    it.each([
      ['a tool of another kind', {googleSearch: {}}],
      ['an empty declaration list', {functionDeclarations: undefined}],
    ])('sends no tools for %s', async (_name, tool) => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(newRequest({config: {tools: [tool]}})),
      );

      expect(sentChatRequest().tools).toBeUndefined();
    });

    it('sends every sampling parameter the request sets', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
          newRequest({
            config: {
              maxOutputTokens: 128,
              temperature: 0.7,
              topP: 0.9,
              topK: 40.6,
              frequencyPenalty: 0.1,
              presencePenalty: 0.2,
              seed: 42,
              stopSequences: ['END', 'STOP'],
            },
          }),
        ),
      );

      expect(sentChatRequest()).toMatchObject({
        maxTokens: 128,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        seed: 42,
        stop: ['END', 'STOP'],
      });
    });

    it('leaves an unset sampling parameter out of the payload', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(newRequest({config: {temperature: 0.5}})),
      );

      const request = sentChatRequest();
      expect(request.temperature).toBe(0.5);
      expect(request).not.toHaveProperty('topP');
      expect(request).not.toHaveProperty('topK');
      expect(request).not.toHaveProperty('stop');
      expect(request).not.toHaveProperty('seed');
      expect(request).not.toHaveProperty('responseFormat');
    });

    it('sends the reasoning effort of the constructor', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({reasoningEffort: 'LOW'}).generateContentAsync(newRequest()),
      );

      expect(sentChatRequest().reasoningEffort).toBe('LOW');
    });

    it('sends inline image bytes as an image data URL', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
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

      expect(sentChatRequest().messages).toEqual([
        {
          role: 'USER',
          content: [
            {type: 'TEXT', text: 'What is this?'},
            {
              type: 'IMAGE',
              imageUrl: {url: `data:image/png;base64,${PNG_BASE64}`},
            },
          ],
        },
      ]);
    });

    it('sends a file uri unchanged', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
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

      expect(sentChatRequest().messages).toEqual([
        {
          role: 'USER',
          content: [
            {type: 'AUDIO', audioUrl: {url: 'https://example.com/clip.mp3'}},
          ],
        },
      ]);
    });

    it('sends a response format built from the request config', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm().generateContentAsync(
          newRequest({config: {responseMimeType: 'application/json'}}),
        ),
      );

      expect(sentChatRequest().responseFormat).toEqual({type: 'JSON_OBJECT'});
    });

    it('rejects when OCI returns no chat result', async () => {
      state.chatMock.mockResolvedValue(null);

      await expect(
        collect(newLlm().generateContentAsync(newRequest())),
      ).rejects.toThrow(/no chat result/);
    });

    it('rejects when OCI returns an event stream instead', async () => {
      state.chatMock.mockResolvedValue(sseStream([]));

      await expect(
        collect(newLlm().generateContentAsync(newRequest())),
      ).rejects.toThrow(/no chat result/);
    });
  });

  describe('generateContentAsync, with streaming', () => {
    it('yields one partial per text delta and then the whole text', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([
          textChunk('Hello'),
          textChunk(' world'),
          textChunk('!'),
          {finishReason: 'stop'},
          usageChunk(10, 5),
        ]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(
        responses.filter((r) => r.partial).map((r) => r.content?.parts),
      ).toEqual([[{text: 'Hello'}], [{text: ' world'}], [{text: '!'}]]);
      const final = responses[responses.length - 1];
      expect(final.partial).toBe(false);
      expect(final.content?.parts).toEqual([{text: 'Hello world!'}]);
    });

    it('asks OCI to stream and to include usage', async () => {
      state.chatMock.mockResolvedValue(sseStream([textChunk('hi')]));

      await collect(newLlm().generateContentAsync(newRequest(), true));

      expect(sentChatRequest().isStream).toBe(true);
      expect(sentChatRequest().streamOptions).toEqual({isIncludeUsage: true});
    });

    it('reports token usage on the final response only', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([textChunk('Hi'), usageChunk(8, 3)]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses[0].usageMetadata).toBeUndefined();
      expect(responses[1].usageMetadata).toEqual({
        promptTokenCount: 8,
        candidatesTokenCount: 3,
        totalTokenCount: 11,
        thoughtsTokenCount: undefined,
      });
    });

    it('surfaces streamed reasoning tokens', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([textChunk('Hi'), usageChunk(8, 3, 17)]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses[1].usageMetadata?.thoughtsTokenCount).toBe(17);
    });

    it('assembles a tool call split across events', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([
          toolChunk({index: 0, id: 'call_stream_1', name: 'get_weather'}),
          toolChunk({index: 0, arguments: '{"city":'}),
          toolChunk({index: 0, arguments: '"Chicago"}'}),
          usageChunk(4, 2),
        ]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts).toEqual([
        {
          functionCall: {
            id: 'call_stream_1',
            name: 'get_weather',
            args: {city: 'Chicago'},
          },
        },
      ]);
    });

    it('keys a tool call by its position when it carries no index', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([
          {
            index: 0,
            message: {
              role: 'ASSISTANT',
              toolCalls: [
                {id: 'a', name: 'alpha', arguments: '{}'},
                {id: 'b', name: 'beta', arguments: '{}'},
              ],
            },
          },
        ]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses[0].content?.parts).toEqual([
        {functionCall: {id: 'a', name: 'alpha', args: {}}},
        {functionCall: {id: 'b', name: 'beta', args: {}}},
      ]);
    });

    it('sorts the assembled tool calls by name', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([
          toolChunk({index: 0, id: 'z', name: 'zulu', arguments: '{}'}),
          toolChunk({index: 1, id: 'a', name: 'alpha', arguments: '{}'}),
          toolChunk({index: 2, id: 'a2', name: 'alpha', arguments: '{}'}),
        ]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(
        responses[0].content?.parts?.map((part) => part.functionCall?.id),
      ).toEqual(['a', 'a2', 'z']);
    });

    it('yields a single empty final response for an empty stream', async () => {
      state.chatMock.mockResolvedValue(sseStream([]));

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses).toEqual([
        {
          content: {role: 'model', parts: []},
          usageMetadata: {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
            thoughtsTokenCount: undefined,
          },
          partial: false,
        },
      ]);
    });

    it('skips an event that is not valid JSON', async () => {
      state.chatMock.mockResolvedValue(
        rawStream(
          'data: {oops\n\ndata: {"message":{"content":[{"type":"TEXT","text":"ok"}]}}\n\ndata: [DONE]\n\n',
        ),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses[0].content?.parts).toEqual([{text: 'ok'}]);
    });

    it('skips an event that carries neither a message nor usage', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([{finishReason: 'stop'}, textChunk('ok')]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses).toHaveLength(2);
      expect(responses[0].content?.parts).toEqual([{text: 'ok'}]);
    });

    it('skips a content block that is not text', async () => {
      state.chatMock.mockResolvedValue(
        sseStream([
          {
            message: {
              content: [{type: 'IMAGE'}, {type: 'TEXT', text: ''}],
            },
          },
        ]),
      );

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts).toEqual([]);
    });

    it.each([
      ['content', {message: {content: 7}}],
      ['toolCalls', {message: {toolCalls: {name: 'oops'}}}],
    ])('skips an event whose %s field is not a list', async (_field, bad) => {
      state.chatMock.mockResolvedValue(sseStream([bad, textChunk('ok')]));

      const responses = await collect(
        newLlm().generateContentAsync(newRequest(), true),
      );

      expect(responses).toHaveLength(2);
      expect(responses[1].content?.parts).toEqual([{text: 'ok'}]);
    });

    it('stops reading once the signal is aborted', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(textChunk('one'))}\n\n`),
          );
        },
      });
      state.chatMock.mockResolvedValue(stream);
      const controller = new AbortController();
      const received: LlmResponse[] = [];

      for await (const response of newLlm().generateContentAsync(
        newRequest(),
        true,
        controller.signal,
      )) {
        received.push(response);
        controller.abort();
      }

      expect(received.map((r) => r.partial)).toEqual([true, false]);
      expect(received[1].content?.parts).toEqual([{text: 'one'}]);
      expect(stream.locked).toBe(false);
    });

    it('rejects when OCI returns a chat result instead of a stream', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await expect(
        collect(newLlm().generateContentAsync(newRequest(), true)),
      ).rejects.toThrow(/no event stream/);
    });

    it('rejects when OCI returns nothing', async () => {
      state.chatMock.mockResolvedValue(null);

      await expect(
        collect(newLlm().generateContentAsync(newRequest(), true)),
      ).rejects.toThrow(/no event stream/);
    });
  });

  describe('concurrency', () => {
    it('builds the client once and answers every caller', async () => {
      state.chatMock.mockImplementation(async ({chatDetails}) => {
        const request = chatDetails.chatRequest;
        const label = isGenericChatRequest(request)
          ? JSON.stringify(request.messages?.[0]?.content)
          : '';
        return chatResponse({text: label});
      });
      const llm = newLlm();

      const answers = await Promise.all(
        [0, 1, 2, 3, 4].map((index) =>
          collect(
            llm.generateContentAsync(
              newRequest({
                contents: [{role: 'user', parts: [{text: `Call ${index}`}]}],
              }),
            ),
          ),
        ),
      );

      expect(state.createdClients).toHaveLength(1);
      expect(answers.map(([first]) => first.content?.parts?.[0].text)).toEqual([
        '[{"type":"TEXT","text":"Call 0"}]',
        '[{"type":"TEXT","text":"Call 1"}]',
        '[{"type":"TEXT","text":"Call 2"}]',
        '[{"type":"TEXT","text":"Call 3"}]',
        '[{"type":"TEXT","text":"Call 4"}]',
      ]);
    });
  });

  describe('configuration', () => {
    it('rejects when no compartment is configured', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await expect(
        collect(
          new OciGenAiLlm({model: MODEL}).generateContentAsync(newRequest()),
        ),
      ).rejects.toThrow(/OCI_COMPARTMENT_ID/);
    });

    it('reads the compartment from the environment', async () => {
      process.env['OCI_COMPARTMENT_ID'] = 'ocid1.compartment.example';
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        new OciGenAiLlm({model: MODEL}).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().compartmentId).toBe('ocid1.compartment.example');
    });

    it('defaults the service endpoint to us-chicago-1', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({serviceEndpoint: undefined}).generateContentAsync(newRequest()),
      );

      expect(state.createdClients[0].endpoint).toBe(SERVICE_ENDPOINT);
    });

    it('reads the service endpoint from the environment', async () => {
      const custom =
        'https://inference.generativeai.eu-frankfurt-1.oci.oraclecloud.com';
      process.env['OCI_SERVICE_ENDPOINT'] = custom;
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({serviceEndpoint: undefined}).generateContentAsync(newRequest()),
      );

      expect(state.createdClients[0].endpoint).toBe(custom);
    });

    it('prefers an explicit service endpoint over the environment', async () => {
      process.env['OCI_SERVICE_ENDPOINT'] = 'https://ignored.example.com';
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({
          serviceEndpoint: 'https://custom.endpoint.example.com',
        }).generateContentAsync(newRequest()),
      );

      expect(state.createdClients[0].endpoint).toBe(
        'https://custom.endpoint.example.com',
      );
    });

    it('uses dedicated serving when an endpoint id is set', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({endpointId: ENDPOINT_ID}).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'DEDICATED',
        endpointId: ENDPOINT_ID,
      });
    });

    it('reads the endpoint id from the environment', async () => {
      process.env['OCI_ENDPOINT_ID'] = 'ocid1.generativeaiendpoint.oc1..env';
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(newLlm().generateContentAsync(newRequest()));

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'DEDICATED',
        endpointId: 'ocid1.generativeaiendpoint.oc1..env',
      });
    });

    it('prefers an explicit endpoint id over the environment', async () => {
      process.env['OCI_ENDPOINT_ID'] = 'ocid1.generativeaiendpoint.oc1..env';
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({endpointId: ENDPOINT_ID}).generateContentAsync(newRequest()),
      );

      expect(sentChatDetails().servingMode).toEqual({
        servingType: 'DEDICATED',
        endpointId: ENDPOINT_ID,
      });
    });
  });

  describe('authentication', () => {
    it('reads the config file by default', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(newLlm().generateContentAsync(newRequest()));

      expect(state.authProviders).toEqual(['API_KEY']);
      expect(state.configFileArgs).toEqual([
        {file: '~/.oci/config', profile: 'DEFAULT'},
      ]);
    });

    it('passes an explicit config file and profile through', async () => {
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

      await collect(
        newLlm({
          authFileLocation: '/etc/oci/config',
          authProfile: 'PROD',
        }).generateContentAsync(newRequest()),
      );

      expect(state.configFileArgs).toEqual([
        {file: '/etc/oci/config', profile: 'PROD'},
      ]);
    });

    it.each(['INSTANCE_PRINCIPAL', 'RESOURCE_PRINCIPAL'] as const)(
      'builds a %s provider',
      async (authType) => {
        state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));

        await collect(newLlm({authType}).generateContentAsync(newRequest()));

        expect(state.authProviders).toEqual([authType]);
      },
    );

    it('retries the client build after a transient failure', async () => {
      state.failNextAuth = true;
      state.chatMock.mockResolvedValue(chatResponse({text: 'hi'}));
      const llm = newLlm();

      await expect(
        collect(llm.generateContentAsync(newRequest())),
      ).rejects.toThrow(/config file is unreadable/);
      const responses = await collect(llm.generateContentAsync(newRequest()));

      expect(responses[0].content?.parts).toEqual([{text: 'hi'}]);
      expect(state.createdClients).toHaveLength(1);
    });
  });

  describe('connect', () => {
    it('rejects, because OCI has no bidirectional API', async () => {
      await expect(newLlm().connect(newRequest())).rejects.toThrow(
        /does not support live connections/,
      );
    });
  });
});

describe('OciGenAiLlm without the OCI SDK installed', () => {
  afterEach(() => {
    vi.doUnmock('oci-generativeaiinference');
    vi.resetModules();
  });

  it('names the packages to install', async () => {
    vi.resetModules();
    vi.doMock('oci-generativeaiinference', () => {
      throw new Error("Cannot find module 'oci-generativeaiinference'");
    });
    const {OciGenAiLlm: FreshOciGenAiLlm} =
      await import('../../src/models/oci_genai_llm.js');
    const llm = new FreshOciGenAiLlm({
      model: MODEL,
      compartmentId: COMPARTMENT_ID,
    });

    await expect(
      collect(llm.generateContentAsync(newRequest())),
    ).rejects.toThrow(/npm install oci-common oci-generativeaiinference/);
  });
});
