/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python tests/unittests/integrations/oci/test_oci_genai_llm.py
// (branch: main). Test names are kept verbatim so a reviewer can grep the
// original.
//
// Three mechanisms have no direct equivalent and are substituted, each noted
// where it is used:
//   - `patch(...GenerativeAiInferenceClient)` becomes a fake client passed
//     through `OCIGenAILlmParams.client`, or a `vi.mock` of the SDK module
//     where the test is about building the client itself.
//   - `isinstance(msg, oci_models.UserMessage)` becomes a check of the `role`
//     discriminator: the TypeScript SDK ships interfaces, not classes.
//   - Python's SSE client returns events; the TypeScript SDK returns a
//     `ReadableStream`, so streaming tests feed real SSE text.

import {LLMRegistry, LlmRequest, LlmResponse} from '@google/adk';
import {
  contentToOciMessages,
  functionDeclarationToOciTool,
  OCIGenAILlm,
  ociResponseToLlmResponse,
} from '@google/adk/models/oci_genai_llm.js';
import {Content, Part, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  fakeOciClient,
  firstText,
  functionDefinitionName,
  isDedicatedServing,
  isJsonSchemaFormat,
  isOnDemandServing,
  makeOciResponse,
  makeStreamChunks,
  makeToolCallResponse,
  mediaUrl,
  sseStreamFrom,
  toolCallId,
  toolCallsOf,
} from './oci_genai_test_utils.js';

/**
 * Doubles for the OCI SDK, used only by the tests that exercise client
 * construction. Every other test injects a client and never loads the SDK.
 */
const ociSdk = vi.hoisted(() => {
  const chat = vi.fn();
  const clients: Array<{endpoint: string; authParams: unknown}> = [];
  class FakeInferenceClient {
    endpoint = '';
    chat = chat;
    constructor(authParams: unknown) {
      clients.push(this as unknown as {endpoint: string; authParams: unknown});
      this.authParams = authParams;
    }
    authParams: unknown;
  }
  const configFileProvider = vi.fn();
  const instancePrincipalBuild = vi.fn(async () => ({kind: 'instance'}));
  class FakeInstancePrincipalBuilder {
    build = instancePrincipalBuild;
  }
  const resourcePrincipalBuilder = vi.fn(() => ({kind: 'resource'}));
  return {
    chat,
    clients,
    FakeInferenceClient,
    configFileProvider,
    FakeInstancePrincipalBuilder,
    instancePrincipalBuild,
    resourcePrincipalBuilder,
  };
});

vi.mock('oci-common', () => ({
  ConfigFileAuthenticationDetailsProvider: ociSdk.configFileProvider,
  InstancePrincipalsAuthenticationDetailsProviderBuilder:
    ociSdk.FakeInstancePrincipalBuilder,
  ResourcePrincipalAuthenticationDetailsProvider: {
    builder: ociSdk.resourcePrincipalBuilder,
  },
}));

vi.mock('oci-generativeaiinference', () => ({
  GenerativeAiInferenceClient: ociSdk.FakeInferenceClient,
}));

const COMPARTMENT_ID = 'ocid1.compartment.oc1..example';
const CHICAGO_ENDPOINT =
  'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com';

/** The `oci_llm` fixture of the Python suite. */
function ociLlm(client = fakeOciClient(makeOciResponse())) {
  return new OCIGenAILlm({
    model: 'google.gemini-2.5-flash',
    compartmentId: COMPARTMENT_ID,
    serviceEndpoint: CHICAGO_ENDPOINT,
    client,
  });
}

/** The `llm_request` fixture of the Python suite. */
function llmRequest(): LlmRequest {
  return {
    model: 'google.gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config: {systemInstruction: 'You are a helpful assistant.'},
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** An `LlmRequest` carrying one user turn and no config. */
function requestWith(text: string, model = 'google.gemini-2.5-flash') {
  return {
    model,
    contents: [{role: 'user', parts: [{text}]}],
    liveConnectConfig: {},
    toolsDict: {},
  } satisfies LlmRequest;
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

/** A function response part, which genai has no literal shorthand for. */
function functionResponsePart(
  name: string,
  response: Record<string, unknown>,
  id?: string,
): Part {
  return {functionResponse: {id, name, response}};
}

beforeEach(() => {
  ociSdk.clients.length = 0;
  ociSdk.chat.mockReset();
  ociSdk.chat.mockResolvedValue(makeOciResponse());
  ociSdk.configFileProvider.mockClear();
  ociSdk.instancePrincipalBuild.mockClear();
  ociSdk.resourcePrincipalBuilder.mockClear();
});

afterEach(() => {
  delete process.env['OCI_COMPARTMENT_ID'];
  delete process.env['OCI_SERVICE_ENDPOINT'];
  delete process.env['OCI_ENDPOINT_ID'];
});

describe('supported_models', () => {
  it('test_supported_models_gemini', () => {
    expect(
      OCIGenAILlm.supportedModels.some((p) => String(p).includes('gemini')),
    ).toBe(true);
  });

  it('test_supported_models_llama', () => {
    expect(
      OCIGenAILlm.supportedModels.some((p) => String(p).includes('llama')),
    ).toBe(true);
  });

  it('test_supported_models_gemma', () => {
    expect(
      OCIGenAILlm.supportedModels.some((p) => String(p).includes('gemma')),
    ).toBe(true);
  });

  it('test_supported_models_registry', () => {
    expect(LLMRegistry.resolve('google.gemini-2.0-flash-001')).toBe(
      OCIGenAILlm,
    );
    expect(LLMRegistry.resolve('meta.llama-3.1-8b-instruct')).toBe(OCIGenAILlm);
    expect(LLMRegistry.resolve('google.gemma-3-27b-it')).toBe(OCIGenAILlm);
  });
});

describe('contentToOciMessages', () => {
  it('test_content_to_oci_message_user_text', () => {
    const content: Content = {role: 'user', parts: [{text: 'Hi there'}]};
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('USER');
    expect(firstText(msgs[0])).toBe('Hi there');
  });

  it('test_content_to_oci_message_assistant_text', () => {
    const content: Content = {role: 'model', parts: [{text: 'I can help.'}]};
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('ASSISTANT');
    expect(firstText(msgs[0])).toBe('I can help.');
  });

  it('test_content_to_oci_message_multi_part_text', () => {
    const content: Content = {
      role: 'user',
      parts: [{text: 'First'}, {text: 'Second'}],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('USER');
    expect(firstText(msgs[0])).toContain('First');
    expect(firstText(msgs[0])).toContain('Second');
  });

  it('test_content_to_oci_message_function_call', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'get_weather', args: {city: 'Toronto'}}}],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('ASSISTANT');
    const calls = toolCallsOf(msgs[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('get_weather');
    expect(JSON.parse(calls[0].arguments ?? '')).toEqual({city: 'Toronto'});
  });

  it('test_content_to_oci_message_function_response', () => {
    const content: Content = {
      role: 'user',
      parts: [
        functionResponsePart(
          'get_weather',
          {result: 'Sunny, 22°C'},
          'call_xyz',
        ),
      ],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('TOOL');
    expect(toolCallId(msgs[0])).toBe('call_xyz');
    expect(firstText(msgs[0])).toBeTruthy();
  });

  it('test_content_to_oci_message_function_response_with_media', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call_xyz',
            name: 'draw_chart',
            response: {title: 'Revenue'},
            parts: [
              {
                inlineData: {
                  data: Buffer.from('chart').toString('base64'),
                  mimeType: 'image/png',
                },
              },
            ],
          },
        },
      ],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('TOOL');
    expect(toolCallId(msgs[0])).toBe('call_xyz');
    expect(msgs[1].role).toBe('USER');
    expect(mediaUrl(msgs[1].content?.[0] ?? {type: ''})).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it('test_content_to_oci_message_multiple_function_responses', () => {
    const content: Content = {
      role: 'user',
      parts: [
        functionResponsePart('get_weather', {result: 'Sunny, 22°C'}, 'call_A'),
        functionResponsePart('get_price', {result: '$150'}, 'call_B'),
      ],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('TOOL');
    expect(toolCallId(msgs[0])).toBe('call_A');
    expect(msgs[1].role).toBe('TOOL');
    expect(toolCallId(msgs[1])).toBe('call_B');
  });

  it('test_content_to_oci_message_multiple_function_responses_no_id', () => {
    const content: Content = {
      role: 'user',
      parts: [
        functionResponsePart('get_weather', {result: 'Sunny, 22°C'}),
        functionResponsePart('get_price', {result: '$150'}),
      ],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(2);
    expect(toolCallId(msgs[0])).toBe('');
    expect(msgs[0].content).toHaveLength(1);
    expect(firstText(msgs[0])).toContain('Sunny');
    expect(toolCallId(msgs[1])).toBe('');
    expect(msgs[1].content).toHaveLength(1);
    expect(firstText(msgs[1])).toContain('$150');
  });

  it('test_content_to_oci_message_mixed_tool_and_text', () => {
    const content: Content = {
      role: 'user',
      parts: [
        functionResponsePart('get_weather', {result: 'Sunny, 22°C'}, 'call_A'),
        {text: 'Here is the weather and some extra text.'},
      ],
    };
    const msgs = contentToOciMessages(content);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('TOOL');
    expect(toolCallId(msgs[0])).toBe('call_A');
    expect(msgs[1].role).toBe('USER');
    expect(firstText(msgs[1])).toBe('Here is the weather and some extra text.');
  });

  it('test_build_chat_details_flattens_multiple_tool_messages', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        model: 'google.gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              functionResponsePart(
                'get_weather',
                {result: 'Sunny, 22°C'},
                'call_A',
              ),
              functionResponsePart('get_price', {result: '$150'}, 'call_B'),
            ],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      }),
    );

    const messages = client.lastChatRequest().messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('TOOL');
    expect(toolCallId(messages[0])).toBe('call_A');
    expect(messages[1].role).toBe('TOOL');
    expect(toolCallId(messages[1])).toBe('call_B');
  });
});

describe('ociResponseToLlmResponse', () => {
  it('test_oci_response_to_llm_response_text', () => {
    const response = makeOciResponse({
      text: 'Here is your answer.',
      promptTokens: 8,
      completionTokens: 4,
    });
    const llmResponse = ociResponseToLlmResponse(response);
    expect(llmResponse.content?.role).toBe('model');
    expect(llmResponse.content?.parts?.[0].text).toBe('Here is your answer.');
    expect(llmResponse.usageMetadata?.promptTokenCount).toBe(8);
    expect(llmResponse.usageMetadata?.candidatesTokenCount).toBe(4);
    expect(llmResponse.usageMetadata?.totalTokenCount).toBe(12);
  });

  it('test_oci_response_to_llm_response_tool_call', () => {
    const response = makeToolCallResponse('get_weather', {city: 'Chicago'});
    const llmResponse = ociResponseToLlmResponse(response);
    expect(llmResponse.content?.role).toBe('model');
    const call = llmResponse.content?.parts?.[0].functionCall;
    expect(call?.name).toBe('get_weather');
    expect(call?.args).toEqual({city: 'Chicago'});
    expect(call?.id).toBe('call_abc123');
  });

  it('test_oci_response_to_llm_response_empty_text', () => {
    const response = makeOciResponse({text: ''});
    const llmResponse = ociResponseToLlmResponse(response);
    expect(llmResponse.content?.parts).toEqual([]);
  });
});

describe('functionDeclarationToOciTool', () => {
  it('test_function_declaration_to_oci_tool_no_parameters', () => {
    const tool = functionDeclarationToOciTool({
      name: 'ping',
      description: 'Check if the service is alive.',
    });
    expect(tool.type).toBe('FUNCTION');
    expect(tool.name).toBe('ping');
    expect(tool.description).toBe('Check if the service is alive.');
    expect(tool.parameters['type']).toBe('object');
    expect(tool.parameters['properties']).toEqual({});
  });

  it('test_function_declaration_to_oci_tool_with_parameters', () => {
    const tool = functionDeclarationToOciTool({
      name: 'get_weather',
      description: 'Get weather for a city.',
      parameters: {
        type: Type.OBJECT,
        properties: {city: {type: Type.STRING, description: 'City name'}},
        required: ['city'],
      },
    });
    expect(tool.name).toBe('get_weather');
    expect(tool.parameters['properties']).toHaveProperty('city');
    expect(tool.parameters['required']).toEqual(['city']);
  });

  it('test_function_declaration_to_oci_tool_json_schema', () => {
    const tool = functionDeclarationToOciTool({
      name: 'validate',
      description: 'Validates a payload.',
      parametersJsonSchema: {
        type: 'object',
        properties: {value: {type: 'string'}},
        required: ['value'],
      },
    });
    expect(tool.parameters['required']).toEqual(['value']);
  });
});

describe('generateContentAsync', () => {
  it('test_generate_content_async_text', async () => {
    const llm = ociLlm(
      fakeOciClient(makeOciResponse({text: 'Hi! I am Gemini on OCI.'})),
    );
    const responses = await collect(llm.generateContentAsync(llmRequest()));
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBe(
      'Hi! I am Gemini on OCI.',
    );
  });

  it('test_generate_content_async_yields_llm_response', async () => {
    const llm = ociLlm();
    const responses = await collect(llm.generateContentAsync(llmRequest()));
    for (const response of responses) {
      expect(response.content).toBeDefined();
      expect(response.usageMetadata).toBeDefined();
    }
  });

  it('test_generate_content_async_with_tools', async () => {
    const client = fakeOciClient(
      makeToolCallResponse('get_weather', {city: 'Chicago'}),
    );
    const llm = ociLlm(client);
    const responses = await collect(
      llm.generateContentAsync({
        model: 'google.gemini-2.0-flash-001',
        contents: [
          {role: 'user', parts: [{text: 'What is the weather in Chicago?'}]},
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
        liveConnectConfig: {},
        toolsDict: {},
      }),
    );
    const call = responses[0].content?.parts?.[0].functionCall;
    expect(call?.name).toBe('get_weather');
    expect(call?.args?.['city']).toBe('Chicago');
  });
});

describe('streaming', () => {
  it('test_streaming_yields_partial_then_final', async () => {
    const llm = ociLlm(
      fakeOciClient(
        sseStreamFrom(makeStreamChunks({textTokens: ['Hello', ' world', '!']})),
      ),
    );
    const responses = await collect(
      llm.generateContentAsync(llmRequest(), true),
    );
    const partial = responses.filter((r) => r.partial);
    const final = responses.filter((r) => !r.partial);
    expect(partial).toHaveLength(3);
    expect(final).toHaveLength(1);
    expect(partial[0].content?.parts?.[0].text).toBe('Hello');
    expect(partial[1].content?.parts?.[0].text).toBe(' world');
    expect(partial[2].content?.parts?.[0].text).toBe('!');
    expect(final[0].content?.parts?.[0].text).toBe('Hello world!');
  });

  it('test_streaming_final_has_usage_metadata', async () => {
    const llm = ociLlm(
      fakeOciClient(
        sseStreamFrom(
          makeStreamChunks({
            textTokens: ['Hi'],
            promptTokens: 8,
            completionTokens: 3,
          }),
        ),
      ),
    );
    const responses = await collect(
      llm.generateContentAsync(llmRequest(), true),
    );
    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    expect(final.usageMetadata?.promptTokenCount).toBe(8);
    expect(final.usageMetadata?.candidatesTokenCount).toBe(3);
    expect(final.usageMetadata?.totalTokenCount).toBe(11);
  });

  it('test_streaming_tool_call', async () => {
    const llm = ociLlm(
      fakeOciClient(
        sseStreamFrom(
          makeStreamChunks({
            toolCalls: [
              {
                id: 'call_stream_1',
                name: 'get_weather',
                args: {city: 'Chicago'},
              },
            ],
          }),
        ),
      ),
    );
    const responses = await collect(
      llm.generateContentAsync(requestWith('Weather in Chicago?'), true),
    );
    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    const call = final.content?.parts?.[0].functionCall;
    expect(call?.name).toBe('get_weather');
    expect(call?.args).toEqual({city: 'Chicago'});
    expect(call?.id).toBe('call_stream_1');
  });

  it('test_streaming_empty_chunks', async () => {
    const llm = ociLlm(fakeOciClient(sseStreamFrom([])));
    const responses = await collect(
      llm.generateContentAsync(llmRequest(), true),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].partial).toBe(false);
  });

  it('test_nonstreaming_uses_call_oci_not_call_oci_stream', async () => {
    // Python asserts which private method ran. The observable equivalent is
    // that the request did not ask OCI to stream.
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    const responses = await collect(
      llm.generateContentAsync(llmRequest(), false),
    );
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.lastChatRequest().isStream).toBeUndefined();
    expect(client.lastChatRequest().streamOptions).toBeUndefined();
    expect(responses).toHaveLength(1);
  });

  it('test_streaming_uses_call_oci_stream_not_call_oci', async () => {
    const client = fakeOciClient(
      sseStreamFrom(makeStreamChunks({textTokens: ['hi']})),
    );
    const llm = ociLlm(client);
    await collect(llm.generateContentAsync(llmRequest(), true));
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.lastChatRequest().isStream).toBe(true);
    expect(client.lastChatRequest().streamOptions).toEqual({
      isIncludeUsage: true,
    });
  });

  it('test_call_oci_stream_iterates_sse_via_events_method', async () => {
    // Python guards that the SDK's SSE client is read through events() rather
    // than iterated. The TypeScript SDK hands back a ReadableStream, so the
    // equivalent guard is that the [DONE] sentinel ends the read and the
    // stream is released and cancelled afterwards.
    const chunks = [
      {
        index: 0,
        message: {role: 'ASSISTANT', content: [{type: 'TEXT', text: 'Hi'}]},
      },
      {finishReason: 'stop'},
      {usage: {promptTokens: 4, completionTokens: 1, totalTokens: 5}},
    ];
    const seen: string[] = [];
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"message":{"content":[{"type":"TEXT","text":"after"}]}}\n\n',
          ),
        );
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const llm = ociLlm(fakeOciClient(stream));
    const responses = await collect(
      llm.generateContentAsync(requestWith('Hi'), true),
    );
    for (const response of responses) {
      const text = response.content?.parts?.[0]?.text;
      if (text !== undefined) {
        seen.push(text);
      }
    }

    expect(seen).toEqual(['Hi', 'Hi']);
    const final = responses[responses.length - 1];
    expect(final.usageMetadata?.totalTokenCount).toBe(5);
    expect(cancelled).toBe(true);
  });
});

describe('concurrent calls', () => {
  it('test_concurrent_async_calls', async () => {
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(async (id) => {
        const llm = ociLlm(
          fakeOciClient(makeOciResponse({text: `Response ${id}`})),
        );
        return collect(llm.generateContentAsync(requestWith(`Call ${id}`)));
      }),
    );
    expect(results).toHaveLength(5);
    results.forEach((responses, id) => {
      expect(responses[0].content?.parts?.[0].text).toBe(`Response ${id}`);
    });
  });

  it('test_concurrent_streaming_calls', async () => {
    const results = await Promise.all(
      [0, 1, 2].map(async (id) => {
        const llm = ociLlm(
          fakeOciClient(
            sseStreamFrom(makeStreamChunks({textTokens: [`Stream${id}`]})),
          ),
        );
        return collect(
          llm.generateContentAsync(requestWith(`Stream ${id}`), true),
        );
      }),
    );
    results.forEach((responses, id) => {
      const final = responses[responses.length - 1];
      expect(final.partial).toBe(false);
      expect(final.content?.parts?.[0].text).toContain(`Stream${id}`);
    });
  });
});

describe('configuration and auth', () => {
  it('test_missing_compartment_id_raises', async () => {
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.5-flash',
      client: fakeOciClient(makeOciResponse()),
    });
    await expect(
      collect(llm.generateContentAsync(llmRequest())),
    ).rejects.toThrow(/compartmentId/);
  });

  it('test_compartment_id_from_env', async () => {
    process.env['OCI_COMPARTMENT_ID'] = 'ocid1.compartment.example';
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({model: 'google.gemini-2.0-flash-001', client});
    await collect(llm.generateContentAsync(llmRequest()));
    expect(client.lastChatDetails().compartmentId).toBe(
      'ocid1.compartment.example',
    );
  });

  it('test_service_endpoint_default', async () => {
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
    });
    await collect(llm.generateContentAsync(llmRequest()));
    expect(ociSdk.clients[0].endpoint).toContain('us-chicago-1');
  });

  it('test_service_endpoint_from_env', async () => {
    const custom =
      'https://inference.generativeai.eu-frankfurt-1.oci.oraclecloud.com';
    process.env['OCI_SERVICE_ENDPOINT'] = custom;
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
    });
    await collect(llm.generateContentAsync(llmRequest()));
    expect(ociSdk.clients[0].endpoint).toBe(custom);
  });

  it('test_service_endpoint_explicit_overrides_env', async () => {
    process.env['OCI_SERVICE_ENDPOINT'] = 'https://ignored.example.com';
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: 'https://custom.endpoint.example.com',
    });
    await collect(llm.generateContentAsync(llmRequest()));
    expect(ociSdk.clients[0].endpoint).toBe(
      'https://custom.endpoint.example.com',
    );
  });

  it('test_build_client_api_key', async () => {
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
      authType: 'API_KEY',
      authProfile: 'DEFAULT',
      authFileLocation: '~/.oci/config',
    });
    await collect(llm.generateContentAsync(llmRequest()));
    expect(ociSdk.configFileProvider).toHaveBeenCalledWith(
      '~/.oci/config',
      'DEFAULT',
    );
    expect(ociSdk.clients).toHaveLength(1);
  });

  it('test_build_client_instance_principal', async () => {
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
      authType: 'INSTANCE_PRINCIPAL',
    });
    await collect(llm.generateContentAsync(llmRequest()));
    expect(ociSdk.instancePrincipalBuild).toHaveBeenCalledTimes(1);
    expect(ociSdk.configFileProvider).not.toHaveBeenCalled();
    expect(ociSdk.clients[0].authParams).toEqual({
      authenticationDetailsProvider: {kind: 'instance'},
    });
  });

  it('test_build_client_resource_principal', async () => {
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
      authType: 'RESOURCE_PRINCIPAL',
    });
    await collect(llm.generateContentAsync(llmRequest()));
    expect(ociSdk.resourcePrincipalBuilder).toHaveBeenCalledTimes(1);
    expect(ociSdk.configFileProvider).not.toHaveBeenCalled();
    expect(ociSdk.clients[0].authParams).toEqual({
      authenticationDetailsProvider: {kind: 'resource'},
    });
  });
});

describe('call parameters', () => {
  it('test_call_oci_passes_model_and_compartment', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      model: 'google.gemini-2.0-flash-001',
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: CHICAGO_ENDPOINT,
      client,
    });
    await collect(
      llm.generateContentAsync(
        requestWith('Hi', 'google.gemini-2.0-flash-001'),
      ),
    );
    expect(client.chat).toHaveBeenCalledTimes(1);
    const details = client.lastChatDetails();
    expect(details.compartmentId).toBe(COMPARTMENT_ID);
    if (!isOnDemandServing(details.servingMode)) {
      expect.fail('Expected on-demand serving mode.');
    }
    expect(details.servingMode.modelId).toBe('google.gemini-2.0-flash-001');
  });

  it('test_call_oci_passes_system_instruction', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        ...requestWith('Hi'),
        config: {systemInstruction: 'Be concise.'},
      }),
    );
    const messages = client.lastChatRequest().messages ?? [];
    expect(messages[0].role).toBe('SYSTEM');
    expect(firstText(messages[0])).toBe('Be concise.');
  });

  it('test_call_oci_passes_tools', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        ...requestWith('Weather?'),
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
    );
    const tools = client.lastChatRequest().tools;
    expect(tools).toHaveLength(1);
    expect(functionDefinitionName(tools?.[0])).toBe('get_weather');
  });
});

describe('serving mode', () => {
  it('test_call_oci_uses_on_demand_serving_mode_by_default', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(llm.generateContentAsync(requestWith('Hi')));
    const servingMode = client.lastChatDetails().servingMode;
    if (!isOnDemandServing(servingMode)) {
      expect.fail('Expected on-demand serving mode.');
    }
    expect(servingMode.modelId).toBe('google.gemini-2.5-flash');
  });

  it('test_call_oci_uses_dedicated_serving_mode_when_endpoint_id_set', async () => {
    const endpointOcid = 'ocid1.generativeaiendpoint.oc1.us-chicago-1.example';
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      model: 'meta.llama-3.1-70b-instruct',
      endpointId: endpointOcid,
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: CHICAGO_ENDPOINT,
      client,
    });
    await collect(
      llm.generateContentAsync(
        requestWith('Hi', 'meta.llama-3.1-70b-instruct'),
      ),
    );
    const servingMode = client.lastChatDetails().servingMode;
    if (!isDedicatedServing(servingMode)) {
      expect.fail('Expected dedicated serving mode.');
    }
    expect(servingMode.endpointId).toBe(endpointOcid);
  });

  it('test_call_oci_uses_dedicated_serving_mode_from_env_var', async () => {
    process.env['OCI_ENDPOINT_ID'] = 'ocid1.generativeaiendpoint.oc1..env';
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      model: 'meta.llama-3.1-70b-instruct',
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: CHICAGO_ENDPOINT,
      client,
    });
    await collect(
      llm.generateContentAsync(
        requestWith('Hi', 'meta.llama-3.1-70b-instruct'),
      ),
    );
    const servingMode = client.lastChatDetails().servingMode;
    if (!isDedicatedServing(servingMode)) {
      expect.fail('Expected dedicated serving mode.');
    }
    expect(servingMode.endpointId).toBe('ocid1.generativeaiendpoint.oc1..env');
  });

  it('test_explicit_endpoint_id_overrides_env_var', async () => {
    process.env['OCI_ENDPOINT_ID'] = 'ocid1.generativeaiendpoint.oc1..env';
    const client = fakeOciClient(makeOciResponse());
    const llm = new OCIGenAILlm({
      model: 'meta.llama-3.1-70b-instruct',
      endpointId: 'ocid1.generativeaiendpoint.oc1..explicit',
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: CHICAGO_ENDPOINT,
      client,
    });
    await collect(
      llm.generateContentAsync(
        requestWith('Hi', 'meta.llama-3.1-70b-instruct'),
      ),
    );
    const servingMode = client.lastChatDetails().servingMode;
    if (!isDedicatedServing(servingMode)) {
      expect.fail('Expected dedicated serving mode.');
    }
    expect(servingMode.endpointId).toBe(
      'ocid1.generativeaiendpoint.oc1..explicit',
    );
  });
});

describe('sampling parameters', () => {
  it('test_call_oci_passes_sampling_params', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        ...requestWith('Hi'),
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
    );
    const request = client.lastChatRequest();
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
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(llm.generateContentAsync(requestWith('Hi')));
    const request = client.lastChatRequest();
    expect(request.temperature).toBeUndefined();
    expect(request.topP).toBeUndefined();
    expect(request.topK).toBeUndefined();
    expect(request.stop).toBeUndefined();
  });
});

describe('multimodal content', () => {
  it('test_inline_image_becomes_image_content_with_data_url', async () => {
    const pngBytes = Buffer.from('\x89PNG\r\n\x1a\n_fake', 'binary');
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        model: 'google.gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {text: 'What is this?'},
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: pngBytes.toString('base64'),
                },
              },
            ],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      }),
    );
    const message = (client.lastChatRequest().messages ?? [])[0];
    expect(message.role).toBe('USER');
    const blocks = message.content ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('TEXT');
    expect(firstText(message)).toBe('What is this?');
    expect(blocks[1].type).toBe('IMAGE');
    const url = mediaUrl(blocks[1]) ?? '';
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(url.split(',')[1], 'base64')).toEqual(pngBytes);
  });

  it('test_file_data_audio_becomes_audio_content', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        model: 'google.gemini-2.5-flash',
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
        liveConnectConfig: {},
        toolsDict: {},
      }),
    );
    const message = (client.lastChatRequest().messages ?? [])[0];
    const blocks = (message.content ?? []).filter((b) => b.type === 'AUDIO');
    expect(blocks).toHaveLength(1);
    expect(mediaUrl(blocks[0])).toBe('https://example.com/clip.mp3');
  });

  it('test_inline_pdf_becomes_document_content', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        model: 'google.gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: Buffer.from('%PDF-1.4').toString('base64'),
                },
              },
            ],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      }),
    );
    const message = (client.lastChatRequest().messages ?? [])[0];
    const blocks = (message.content ?? []).filter((b) => b.type === 'DOCUMENT');
    expect(blocks).toHaveLength(1);
    const url = mediaUrl(blocks[0]) ?? '';
    expect(url.startsWith('data:application/pdf;base64,')).toBe(true);
  });
});

describe('response format', () => {
  it('test_response_schema_emits_json_schema_response_format', async () => {
    const schema = {
      title: 'Weather',
      type: 'object',
      properties: {city: {type: 'string'}, temp_c: {type: 'number'}},
      required: ['city', 'temp_c'],
    };
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        ...requestWith('Chicago weather?'),
        config: {responseMimeType: 'application/json', responseSchema: schema},
      }),
    );
    const responseFormat = client.lastChatRequest().responseFormat;
    if (!isJsonSchemaFormat(responseFormat)) {
      expect.fail('Expected a JSON schema response format.');
    }
    expect(responseFormat.jsonSchema?.name).toBe('Weather');
    expect(responseFormat.jsonSchema?.schema).toEqual(schema);
    expect(responseFormat.jsonSchema?.isStrict).toBe(true);
  });

  it('test_response_mime_type_only_emits_json_object_format', async () => {
    const client = fakeOciClient(makeOciResponse());
    const llm = ociLlm(client);
    await collect(
      llm.generateContentAsync({
        ...requestWith('JSON please'),
        config: {responseMimeType: 'application/json'},
      }),
    );
    expect(client.lastChatRequest().responseFormat?.type).toBe('JSON_OBJECT');
  });
});

describe('reasoning tokens', () => {
  it('test_nonstreaming_surfaces_reasoning_tokens', () => {
    const response = makeOciResponse({
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 42,
    });
    expect(
      ociResponseToLlmResponse(response).usageMetadata?.thoughtsTokenCount,
    ).toBe(42);
  });

  it('test_streaming_surfaces_reasoning_tokens', async () => {
    const llm = ociLlm(
      fakeOciClient(
        sseStreamFrom(
          makeStreamChunks({
            textTokens: ['Hi'],
            promptTokens: 8,
            completionTokens: 3,
            reasoningTokens: 17,
          }),
        ),
      ),
    );
    const responses = await collect(
      llm.generateContentAsync(llmRequest(), true),
    );
    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    expect(final.usageMetadata?.thoughtsTokenCount).toBe(17);
  });
});
