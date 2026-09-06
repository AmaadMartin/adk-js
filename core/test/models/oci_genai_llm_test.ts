/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, LlmResponse} from '@google/adk';
import {
  buildResponseFormat,
  contentToOciMessages,
  functionResponseMediaBlocks,
  OCIGenAILlm,
  ociResponseToLlmResponse,
  toOciRole,
} from '@google/adk/models/oci_genai_llm.js';
import type {OptionalPeer} from '@google/adk/utils/optional_peer.js';
import {Type} from '@google/genai';
import type {models} from 'oci-generativeaiinference';
import {models as ociModels} from 'oci-generativeaiinference';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

import {
  fakeOciClient,
  firstText,
  functionDefinitionName,
  isJsonSchemaFormat,
  makeOciResponse,
  makeStreamChunks,
  mediaUrl,
  sseStreamFrom,
  sseStreamFromText,
  toolCallsOf,
} from './oci_genai_test_utils.js';

const COMPARTMENT_ID = 'ocid1.compartment.oc1..example';

/** An `LlmRequest` carrying one user turn. */
function requestWith(text = 'Hi', config?: LlmRequest['config']): LlmRequest {
  return {
    model: 'google.gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text}]}],
    config,
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Drains a response generator into an array. */
async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

/** Builds a provider whose calls are answered by `bodies`, in turn. */
function providerWith(...bodies: Parameters<typeof fakeOciClient>): {
  llm: OCIGenAILlm;
  client: ReturnType<typeof fakeOciClient>;
} {
  const client = fakeOciClient(...bodies);
  return {
    llm: new OCIGenAILlm({compartmentId: COMPARTMENT_ID, client}),
    client,
  };
}

/** The GenericChat request a single non-streaming call produced. */
async function chatRequestFor(
  request: LlmRequest,
): Promise<models.GenericChatRequest> {
  const {llm, client} = providerWith(makeOciResponse());
  await collect(llm.generateContentAsync(request));
  return client.lastChatRequest();
}

afterEach(() => {
  vi.doUnmock('oci-common');
  vi.doUnmock('oci-generativeaiinference');
  vi.doUnmock('@google/adk/utils/optional_peer.js');
  vi.resetModules();
  delete process.env['OCI_COMPARTMENT_ID'];
  delete process.env['OCI_SERVICE_ENDPOINT'];
  delete process.env['OCI_ENDPOINT_ID'];
});

describe('defaults', () => {
  it('serves adk-python default model when none is given', () => {
    expect(new OCIGenAILlm().model).toBe('google.gemini-2.5-flash');
  });

  it('sends the default token budget', async () => {
    expect((await chatRequestFor(requestWith())).maxTokens).toBe(2048);
  });

  it('sends the constructor token budget', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      compartmentId: COMPARTMENT_ID,
      maxTokens: 64,
      client,
    });
    await collect(llm.generateContentAsync(requestWith()));
    expect(client.lastChatRequest().maxTokens).toBe(64);
  });

  it('lets the request token budget win over the constructor one', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      compartmentId: COMPARTMENT_ID,
      maxTokens: 64,
      client,
    });
    await collect(
      llm.generateContentAsync(requestWith('Hi', {maxOutputTokens: 8})),
    );
    expect(client.lastChatRequest().maxTokens).toBe(8);
  });

  it('sends the constructor reasoning effort', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      compartmentId: COMPARTMENT_ID,
      reasoningEffort: 'LOW' as models.GenericChatRequest.ReasoningEffort,
      client,
    });
    await collect(llm.generateContentAsync(requestWith()));
    expect(client.lastChatRequest().reasoningEffort).toBe('LOW');
  });

  it('omits the reasoning effort when none is set', async () => {
    expect(
      (await chatRequestFor(requestWith())).reasoningEffort,
    ).toBeUndefined();
  });
});

describe('connect', () => {
  it('refuses to open a live connection', () => {
    expect(() => new OCIGenAILlm().connect()).toThrow(
      /no bidirectional live API/,
    );
  });
});

describe('sampling parameters that are falsy', () => {
  it('sends a temperature of zero', async () => {
    expect(
      (await chatRequestFor(requestWith('Hi', {temperature: 0}))).temperature,
    ).toBe(0);
  });

  it('sends a seed of zero', async () => {
    expect((await chatRequestFor(requestWith('Hi', {seed: 0}))).seed).toBe(0);
  });

  it('sends a topP of zero', async () => {
    expect((await chatRequestFor(requestWith('Hi', {topP: 0}))).topP).toBe(0);
  });

  it('truncates a fractional topK to an integer', async () => {
    expect((await chatRequestFor(requestWith('Hi', {topK: 40.7}))).topK).toBe(
      40,
    );
  });

  it('omits an empty stop sequence list', async () => {
    expect(
      (await chatRequestFor(requestWith('Hi', {stopSequences: []}))).stop,
    ).toBeUndefined();
  });

  it('copies the stop sequences rather than sharing the array', async () => {
    const stopSequences = ['END'];
    const request = await chatRequestFor(requestWith('Hi', {stopSequences}));
    stopSequences.push('LATER');
    expect(request.stop).toEqual(['END']);
  });
});

describe('response format', () => {
  it('maps text/plain to the text format', () => {
    expect(buildResponseFormat({responseMimeType: 'text/plain'})).toEqual({
      type: 'TEXT',
    });
  });

  it('sends no format when nothing asks for one', () => {
    expect(buildResponseFormat({})).toBeUndefined();
  });

  it('sends no format for an unrecognised mime type', () => {
    expect(buildResponseFormat({responseMimeType: 'text/csv'})).toBeUndefined();
  });

  it('sends no format for a schema that is not an object', () => {
    expect(
      buildResponseFormat({responseSchema: 'not a schema'}),
    ).toBeUndefined();
  });

  it('converts a genai schema out of the uppercase dialect', () => {
    const format = buildResponseFormat({
      responseSchema: {
        title: 'City',
        type: Type.OBJECT,
        properties: {name: {type: Type.STRING}},
      },
    });
    if (!isJsonSchemaFormat(format)) {
      expect.fail('Expected a JSON schema response format.');
    }
    expect(format.jsonSchema?.name).toBe('City');
    expect(format.jsonSchema?.schema).toEqual({
      title: 'City',
      type: 'object',
      properties: {name: {type: 'string'}},
    });
  });

  it('converts a Zod schema', () => {
    const format = buildResponseFormat({
      responseSchema: z.object({city: z.string()}),
    });
    if (!isJsonSchemaFormat(format)) {
      expect.fail('Expected a JSON schema response format.');
    }
    expect(format.jsonSchema?.schema).toMatchObject({
      type: 'object',
      properties: {city: {type: 'string'}},
    });
  });

  it('names an untitled schema "response"', () => {
    const format = buildResponseFormat({
      responseSchema: {type: 'object', description: 'A city.'},
    });
    if (!isJsonSchemaFormat(format)) {
      expect.fail('Expected a JSON schema response format.');
    }
    expect(format.jsonSchema?.name).toBe('response');
    expect(format.jsonSchema?.description).toBe('A city.');
  });

  it('lets a schema win over a mime type', () => {
    const format = buildResponseFormat({
      responseMimeType: 'text/plain',
      responseSchema: {type: 'object'},
    });
    expect(format?.type).toBe('JSON_SCHEMA');
  });
});

describe('multimodal content', () => {
  it('maps a video mime type to a video block', () => {
    const messages = contentToOciMessages({
      role: 'user',
      parts: [
        {fileData: {fileUri: 'gs://bucket/clip.mp4', mimeType: 'video/mp4'}},
      ],
    });
    const block = messages[0].content?.[0];
    expect(block?.type).toBe('VIDEO');
    expect(mediaUrl(block ?? {type: ''})).toBe('gs://bucket/clip.mp4');
  });

  it('falls back to an octet-stream data URL when a blob has no mime type', () => {
    const messages = contentToOciMessages({
      role: 'user',
      parts: [{inlineData: {data: 'AAAA'}}],
    });
    const block = messages[0].content?.[0];
    expect(block?.type).toBe('DOCUMENT');
    expect(mediaUrl(block ?? {type: ''})).toBe(
      'data:application/octet-stream;base64,AAAA',
    );
  });

  it('sends file data without a mime type as a document', () => {
    const messages = contentToOciMessages({
      role: 'user',
      parts: [{fileData: {fileUri: 'https://example.com/thing'}}],
    });
    expect(messages[0].content?.[0].type).toBe('DOCUMENT');
  });

  it('drops a part that carries neither bytes nor a URI', () => {
    const messages = contentToOciMessages({
      role: 'user',
      parts: [{inlineData: {mimeType: 'image/png'}}],
    });
    expect(messages[0].content).toEqual([]);
  });

  it('skips tool response media that has no mime type', () => {
    expect(
      functionResponseMediaBlocks({
        name: 'draw',
        parts: [
          {inlineData: {data: 'AAAA'}},
          {inlineData: {mimeType: 'image/png'}},
          {inlineData: {data: 'BBBB', mimeType: 'image/png'}},
        ],
      }),
    ).toHaveLength(1);
  });

  it('reads no media from a tool response that attached none', () => {
    expect(functionResponseMediaBlocks({name: 'draw'})).toEqual([]);
  });

  it('serialises a tool response that carries no payload', () => {
    const messages = contentToOciMessages({
      role: 'user',
      parts: [{functionResponse: {id: 'c1', name: 'draw'}}],
    });
    expect(firstText(messages[0])).toBe('{}');
  });

  it('serialises a tool call that carries no arguments', () => {
    const messages = contentToOciMessages({
      role: 'model',
      parts: [{functionCall: {id: 'c1', name: 'ping'}}],
    });
    expect(toolCallsOf(messages[0])[0].arguments).toBe('{}');
  });
});

describe('tool declarations', () => {
  it('sends an empty description when a declaration has none', async () => {
    const request = await chatRequestFor(
      requestWith('Hi', {
        tools: [{functionDeclarations: [{name: 'ping'}]}],
      }),
    );
    expect(functionDefinitionName(request.tools?.[0])).toBe('ping');
    expect((request.tools?.[0] as models.FunctionDefinition).description).toBe(
      '',
    );
  });

  it('sends no tools when the first tool declares no functions', async () => {
    expect(
      (await chatRequestFor(requestWith('Hi', {tools: [{}]}))).tools,
    ).toBeUndefined();
  });

  it('sends no tools when the declaration list is absent', async () => {
    expect(
      (
        await chatRequestFor(
          requestWith('Hi', {tools: [{functionDeclarations: undefined}]}),
        )
      ).tools,
    ).toBeUndefined();
  });

  it('sends no tools when the tool list is empty', async () => {
    expect(
      (await chatRequestFor(requestWith('Hi', {tools: []}))).tools,
    ).toBeUndefined();
  });
});

describe('role mapping', () => {
  it('maps the assistant alias onto the assistant role', () => {
    expect(toOciRole('assistant')).toBe('ASSISTANT');
    expect(toOciRole('model')).toBe('ASSISTANT');
  });

  it('maps an absent role onto the user role', () => {
    expect(toOciRole()).toBe('USER');
    expect(toOciRole('user')).toBe('USER');
  });

  it('sends an empty user message for a content with no parts', () => {
    const messages = contentToOciMessages({role: 'user'});
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('USER');
    expect(messages[0].content).toEqual([]);
  });

  it('keeps an assistant turn that carries only tool calls', () => {
    const messages = contentToOciMessages({
      role: 'model',
      parts: [{functionCall: {name: 'ping', args: {}}}],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([]);
    expect(toolCallsOf(messages[0])[0].id).toBe('');
  });

  it('sends a system instruction that is not a string as content instead', async () => {
    const request = await chatRequestFor(
      requestWith('Hi', {systemInstruction: {parts: [{text: 'Be brief.'}]}}),
    );
    expect(request.messages?.[0].role).toBe('USER');
    expect(firstText(request.messages?.[0] ?? {role: ''})).toBe('Hi');
  });
});

describe('malformed tool arguments', () => {
  it('reads unparseable arguments as an empty object', () => {
    const response = ociResponseToLlmResponse(
      makeOciResponse({
        text: '',
        toolCalls: [
          {id: 'c1', type: 'FUNCTION', name: 'get', arguments: '{oops'},
        ],
      }),
    );
    expect(response.content?.parts?.[0].functionCall?.args).toEqual({});
  });

  it('reads a non-object argument payload as an empty object', () => {
    const response = ociResponseToLlmResponse(
      makeOciResponse({
        text: '',
        toolCalls: [{id: 'c1', type: 'FUNCTION', name: 'get', arguments: '7'}],
      }),
    );
    expect(response.content?.parts?.[0].functionCall?.args).toEqual({});
  });

  it('reads absent arguments as an empty object', () => {
    const response = ociResponseToLlmResponse(
      makeOciResponse({
        text: '',
        toolCalls: [{id: 'c1', type: 'FUNCTION', name: 'get'}],
      }),
    );
    expect(response.content?.parts?.[0].functionCall?.args).toEqual({});
  });

  it('reads no content from a chat response in another API format', () => {
    const response = makeOciResponse();
    const cohere: models.CohereChatResponse = {
      apiFormat: 'COHERE',
      text: 'ignored',
      chatHistory: [],
      finishReason: ociModels.CohereChatResponse.FinishReason.Complete,
    };
    const other = {
      ...response,
      chatResult: {...response.chatResult, chatResponse: cohere},
    };
    const llmResponse = ociResponseToLlmResponse(other);
    expect(llmResponse.content?.parts).toEqual([]);
    expect(llmResponse.usageMetadata?.totalTokenCount).toBe(0);
  });

  it('reads an empty id from a tool call that has none', () => {
    const nameless = {type: 'FUNCTION', name: 'get', arguments: '{}'};
    const response = ociResponseToLlmResponse(
      makeOciResponse({
        text: '',
        toolCalls: [nameless as models.FunctionCall],
      }),
    );
    expect(response.content?.parts?.[0].functionCall?.id).toBe('');
  });

  it('reads no parts from a response with no choices', () => {
    const base = makeOciResponse();
    const generic = base.chatResult.chatResponse as models.GenericChatResponse;
    const response = {
      ...base,
      chatResult: {
        ...base.chatResult,
        chatResponse: {...generic, choices: []},
      },
    };
    expect(ociResponseToLlmResponse(response).content?.parts).toEqual([]);
  });

  it('reads no tool calls from a message whose list is absent', () => {
    const base = makeOciResponse();
    const generic = base.chatResult.chatResponse as models.GenericChatResponse;
    const message: models.AssistantMessage = {
      role: 'ASSISTANT',
      content: [],
      toolCalls: undefined,
    };
    const response = {
      ...base,
      chatResult: {
        ...base.chatResult,
        chatResponse: {
          ...generic,
          choices: [{index: 0, finishReason: 'stop', message}],
        },
      },
    };
    expect(ociResponseToLlmResponse(response).content?.parts).toEqual([]);
  });

  it('reads no text from a content block that carries none', () => {
    const base = makeOciResponse();
    const generic = base.chatResult.chatResponse as models.GenericChatResponse;
    const imageBlock: models.ImageContent = {type: 'IMAGE'};
    const response = {
      ...base,
      chatResult: {
        ...base.chatResult,
        chatResponse: {
          ...generic,
          choices: [
            {
              index: 0,
              finishReason: 'stop',
              message: {role: 'ASSISTANT', content: [imageBlock]},
            },
          ],
        },
      },
    };
    expect(ociResponseToLlmResponse(response).content?.parts).toEqual([]);
  });

  it('reads a tool call that is not a function call', () => {
    const response = ociResponseToLlmResponse(
      makeOciResponse({
        text: '',
        toolCalls: [{id: 'c1', type: 'OTHER'} as models.FunctionCall],
      }),
    );
    const call = response.content?.parts?.[0].functionCall;
    expect(call?.id).toBe('c1');
    expect(call?.name).toBeUndefined();
  });
});

describe('streaming', () => {
  it('skips a frame that is not JSON', async () => {
    const {llm} = providerWith(
      sseStreamFromText([
        'data: not json\n\n',
        `data: ${JSON.stringify(
          makeStreamChunks({textTokens: ['ok']})[0],
        )}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses[0].content?.parts?.[0].text).toBe('ok');
  });

  it('skips a frame that is JSON but not an object', async () => {
    const {llm} = providerWith(
      sseStreamFromText(['data: 42\n\n', 'data: [DONE]\n\n']),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([]);
  });

  it('skips a chunk that carries neither usage nor a message', async () => {
    const {llm} = providerWith(sseStreamFrom([{finishReason: 'stop'}]));
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses).toHaveLength(1);
  });

  it('skips a content block that is not text', async () => {
    const {llm} = providerWith(
      sseStreamFrom([
        {message: {content: [{type: 'IMAGE'}, {type: 'TEXT', text: ''}]}},
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([]);
  });

  it('concatenates tool arguments split across chunks', async () => {
    const {llm} = providerWith(
      sseStreamFrom([
        {
          message: {
            toolCalls: [{index: 0, id: 'c1', name: 'get', arguments: '{"a"'}],
          },
        },
        {message: {toolCalls: [{index: 0, arguments: ':1}'}]}},
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    const call = responses[0].content?.parts?.[0].functionCall;
    expect(call?.name).toBe('get');
    expect(call?.args).toEqual({a: 1});
  });

  it('reads a tool-call delta that carries no arguments', async () => {
    const {llm} = providerWith(
      sseStreamFrom([
        {message: {toolCalls: [{index: 0, id: 'c1', name: 'get'}]}},
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses[0].content?.parts?.[0].functionCall?.args).toEqual({});
  });

  it('reads a usage chunk that omits its token counts', async () => {
    const {llm} = providerWith(sseStreamFrom([{usage: {totalTokens: 3}}]));
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses[0].usageMetadata?.promptTokenCount).toBe(0);
    expect(responses[0].usageMetadata?.candidatesTokenCount).toBe(0);
    expect(responses[0].usageMetadata?.thoughtsTokenCount).toBeUndefined();
  });

  it('keys a tool call by position when the chunk carries no index', async () => {
    const {llm} = providerWith(
      sseStreamFrom([
        {
          message: {
            toolCalls: [
              {id: 'c1', name: 'alpha', arguments: '{}'},
              {id: 'c2', name: 'beta', arguments: '{}'},
            ],
          },
        },
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    const parts = responses[0].content?.parts ?? [];
    expect(parts.map((p) => p.functionCall?.id)).toEqual(['c1', 'c2']);
  });

  it('orders the accumulated tool calls by name', async () => {
    const {llm} = providerWith(
      sseStreamFrom([
        {
          message: {
            toolCalls: [{index: 0, id: 'c1', name: 'zulu', arguments: '{}'}],
          },
        },
        {
          message: {
            toolCalls: [{index: 1, id: 'c2', name: 'alpha', arguments: '{}'}],
          },
        },
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    const parts = responses[0].content?.parts ?? [];
    expect(parts.map((p) => p.functionCall?.name)).toEqual(['alpha', 'zulu']);
  });

  it('stops reading when the caller aborts', async () => {
    const controller = new AbortController();
    const {llm} = providerWith(
      sseStreamFrom(makeStreamChunks({textTokens: ['one', 'two', 'three']})),
    );
    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(
      requestWith(),
      true,
      controller.signal,
    )) {
      responses.push(response);
      controller.abort();
    }
    expect(responses).toHaveLength(2);
    expect(responses[0].content?.parts?.[0].text).toBe('one');
    expect(responses[1].partial).toBe(false);
    expect(responses[1].content?.parts?.[0].text).toBe('one');
  });

  it('refuses a streaming answer that is not a stream', async () => {
    const {llm} = providerWith(makeOciResponse());
    await expect(
      collect(llm.generateContentAsync(requestWith(), true)),
    ).rejects.toThrow(/without a stream/);
  });
});

describe('the OCI SDK as an optional peer', () => {
  it('names the feature and the package when the SDK is absent', async () => {
    // The real loader runs; only the dynamic import is forced to fail the way
    // Node fails on a package that is not installed.
    vi.resetModules();
    vi.doMock('@google/adk/utils/optional_peer.js', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('@google/adk/utils/optional_peer.js')
        >();
      return {
        ...actual,
        loadOptionalPeer: (peer: OptionalPeer) => {
          const error: Error & {code?: string} = new Error(
            `Cannot find package '${peer.packageName}'`,
          );
          error.code = 'ERR_MODULE_NOT_FOUND';
          return actual.loadOptionalPeer(peer, () => Promise.reject(error));
        },
      };
    });
    const module = await import('@google/adk/models/oci_genai_llm.js');
    const llm = new module.OCIGenAILlm({compartmentId: COMPARTMENT_ID});
    await expect(
      collect(llm.generateContentAsync(requestWith())),
    ).rejects.toThrow(
      /OCIGenAILlm requires the optional peer dependency "oci-(generativeaiinference|common)"/,
    );
  });

  it('builds one client for two concurrent first calls', async () => {
    const built: unknown[] = [];
    const chat = vi.fn(async () => makeOciResponse());
    vi.resetModules();
    vi.doMock('oci-generativeaiinference', () => ({
      GenerativeAiInferenceClient: class {
        endpoint = '';
        chat = chat;
        constructor(params: unknown) {
          built.push(params);
        }
      },
    }));
    vi.doMock('oci-common', () => ({
      ConfigFileAuthenticationDetailsProvider: class {},
    }));
    const module = await import('@google/adk/models/oci_genai_llm.js');
    const llm = new module.OCIGenAILlm({compartmentId: COMPARTMENT_ID});

    await Promise.all([
      collect(llm.generateContentAsync(requestWith('one'))),
      collect(llm.generateContentAsync(requestWith('two'))),
    ]);

    expect(built).toHaveLength(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe('server-sent event framing', () => {
  it('reassembles a frame split across two chunks', async () => {
    const frame = `data: ${JSON.stringify(
      makeStreamChunks({textTokens: ['split']})[0],
    )}\n\n`;
    const {llm} = providerWith(
      sseStreamFromText([
        frame.slice(0, 20),
        frame.slice(20),
        'data: [DONE]\n\n',
      ]),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith(), true),
    );
    expect(responses[0].content?.parts?.[0].text).toBe('split');
  });
});
