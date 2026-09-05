/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the reference tests of adk-python
 * `tests/unittests/models/test_gemma_llm.py` (branch `main`). Each `it(...)`
 * keeps the Python test name so the two suites can be compared by name.
 *
 * The four `Gemma3Ollama` tests are not ported: that class needs `LiteLlm`,
 * which adk-js does not have.
 */

import {Gemini, Gemma, LLMRegistry, LlmRequest, LlmResponse} from '@google/adk';
import {createPartFromText, Modality, Part, Tool, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  extractFunctionCallsFromResponse,
  preprocessGemmaRequest,
} from '../../src/models/gemma_llm.js';

/** adk-js requires an API key at construction; adk-python does not. */
const TEST_API_KEY = 'test-key';

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function llmRequest(): LlmRequest {
  return makeRequest({
    model: 'gemma-3-4b-it',
    contents: [{role: 'user', parts: [createPartFromText('Hello')]}],
    config: {
      temperature: 0.1,
      responseModalities: [Modality.TEXT],
      systemInstruction: 'You are a helpful assistant',
    },
  });
}

function llmRequestWithDuplicateInstruction(): LlmRequest {
  return makeRequest({
    model: 'gemma-3-1b-it',
    contents: [
      {role: 'user', parts: [createPartFromText('Talk like a pirate.')]},
      {role: 'user', parts: [createPartFromText('Hello')]},
    ],
    config: {
      responseModalities: [Modality.TEXT],
      systemInstruction: 'Talk like a pirate.',
    },
  });
}

function llmRequestWithTools(): LlmRequest {
  const tool: Tool = {
    functionDeclarations: [
      {
        name: 'search_web',
        description: 'Search the web for a query.',
        parameters: {
          type: Type.OBJECT,
          properties: {query: {type: Type.STRING}},
          required: ['query'],
        },
      },
      {
        name: 'get_current_time',
        description: 'Gets the current time.',
        parameters: {type: Type.OBJECT, properties: {}},
      },
    ],
  };
  return makeRequest({
    model: 'gemma-3-1b-it',
    contents: [{role: 'user', parts: [createPartFromText('Hello')]}],
    config: {tools: [tool]},
  });
}

function textResponse(
  text: string,
  extra: Partial<LlmResponse> = {},
): LlmResponse {
  return {
    content: {role: 'model', parts: [createPartFromText(text)]},
    ...extra,
  };
}

/** Reads the parts of a response, failing the test when it has none. */
function partsOf(llmResponse: LlmResponse): Part[] {
  const parts = llmResponse.content?.parts;
  if (!parts) {
    expect.fail('the response carries no parts');
  }
  return parts;
}

async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

describe('GemmaLlm', () => {
  const clearEnv = () => {
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_GENAI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
    delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
  };

  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('test_supported_models_matches_gemma4', () => {
    expect(LLMRegistry.resolve('gemma-4-31b-it')).toBe(Gemini);
  });

  it('test_supported_models_matches_gemma3', () => {
    expect(LLMRegistry.resolve('gemma-3-27b-it')).toBe(Gemma);
  });

  it('test_not_gemma_model', async () => {
    const llm = new Gemma({apiKey: TEST_API_KEY});
    const request = makeRequest({model: 'not-a-gemma-model'});

    // adk-python raises AssertionError; TypeScript has no `assert`, so the
    // port throws Error with the same message.
    await expect(collect(llm.generateContentAsync(request))).rejects.toThrow(
      /model/,
    );
  });

  it('test_preprocess_request[llm_request]', () => {
    const request = llmRequest();
    const wantContentText = request.config?.systemInstruction;

    preprocessGemmaRequest(request);

    expect(request.config?.systemInstruction).toBeFalsy();
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].role).toBe('user');
    expect(request.contents[0].parts?.[0].text).toBe(wantContentText);
  });

  it('test_preprocess_request[llm_request_with_duplicate_instruction]', () => {
    const request = llmRequestWithDuplicateInstruction();
    const wantContentText = request.config?.systemInstruction;

    preprocessGemmaRequest(request);

    expect(request.config?.systemInstruction).toBeFalsy();
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].role).toBe('user');
    expect(request.contents[0].parts?.[0].text).toBe(wantContentText);
  });

  it('test_preprocess_request_with_tools', () => {
    const request = llmRequestWithTools();

    preprocessGemmaRequest(request);

    expect(request.config?.tools).toHaveLength(0);

    expect(request.contents[1].role).toBe('user');
    expect(request.contents[1].parts?.[0].text).toBe('Hello');

    const instruction = request.contents[0].parts?.[0].text;
    expect(instruction).toBeDefined();
    expect(instruction).toContain('You have access to the following functions');
    // adk-python serializes with pydantic, which orders fields by declaration
    // (`description` first). `JSON.stringify` follows insertion order, so the
    // two SDKs emit the same fields in a different order.
    expect(instruction).toContain(
      '{"name":"search_web","description":"Search the web for a query.",',
    );
    expect(instruction).toContain(
      '{"name":"get_current_time","description":"Gets the current time.","parameters":{"type":"OBJECT","properties":{}}}',
    );
  });

  it('test_preprocess_request_with_function_response', () => {
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionResponse: {
                name: 'search_web',
                response: {results: [{title: 'ADK'}]},
              },
            },
          ],
        },
      ],
      config: {},
    });

    preprocessGemmaRequest(request);

    expect(request.contents).toHaveLength(1);
    expect(request.contents[0].role).toBe('user');
    const part = request.contents[0].parts?.[0];
    expect(part?.text).toBe(
      'Invoking tool `search_web` produced: `{"results": [{"title": "ADK"}]}`.',
    );
    expect(part?.functionResponse).toBeUndefined();
    expect(part?.functionCall).toBeUndefined();
  });

  it('test_preprocess_request_with_function_call', () => {
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [
        {
          role: 'user',
          parts: [{functionCall: {name: 'get_current_time', args: {}}}],
        },
      ],
    });

    preprocessGemmaRequest(request);

    expect(request.contents).toHaveLength(1);
    expect(request.contents[0].role).toBe('model');
    const part = request.contents[0].parts?.[0];
    // adk-python emits `{"args":{},"name":"get_current_time"}`; pydantic orders
    // fields by declaration and `JSON.stringify` by insertion.
    expect(part?.text).toBe('{"name":"get_current_time","args":{}}');
    expect(part?.functionCall).toBeUndefined();
    expect(part?.functionResponse).toBeUndefined();
  });

  it('test_preprocess_request_with_mixed_content', () => {
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [
        {role: 'user', parts: [createPartFromText('Hello!')]},
        {
          role: 'model',
          parts: [
            {functionCall: {name: 'get_weather', args: {city: 'London'}}},
          ],
        },
        {
          role: 'some_function',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: {temp: '15C'},
              },
            },
          ],
        },
        {role: 'user', parts: [createPartFromText('How are you?')]},
      ],
    });

    preprocessGemmaRequest(request);

    expect(request.contents).toHaveLength(4);

    expect(request.contents[0].role).toBe('user');
    expect(request.contents[0].parts?.[0].text).toBe('Hello!');

    expect(request.contents[1].role).toBe('model');
    expect(request.contents[1].parts?.[0].text).toBe(
      '{"name":"get_weather","args":{"city":"London"}}',
    );

    expect(request.contents[2].role).toBe('user');
    expect(request.contents[2].parts?.[0].text).toBe(
      'Invoking tool `get_weather` produced: `{"temp": "15C"}`.',
    );

    expect(request.contents[3].role).toBe('user');
    expect(request.contents[3].parts?.[0].text).toBe('How are you?');
  });

  it('test_process_response', () => {
    const response = textResponse(
      '{"name": "search_web", "parameters": {"query": "latest news"}}',
    );

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    const part = partsOf(response)[0];
    expect(part.functionCall).toEqual({
      name: 'search_web',
      args: {query: 'latest news'},
    });
    expect(part.text).toBeUndefined();
  });

  it('test_process_response_invalid_json_text', () => {
    const originalText = 'This is a regular text response.';
    const response = textResponse(originalText);

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].text).toBe(originalText);
    expect(partsOf(response)[0].functionCall).toBeUndefined();
  });

  it('test_process_response_malformed_json', () => {
    const malformedJson = '{"not_a_function": "value", "another_field": 123}';
    const response = textResponse(malformedJson);

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].text).toBe(malformedJson);
    expect(partsOf(response)[0].functionCall).toBeUndefined();
  });

  it('test_process_response_empty_content_or_multiple_parts', () => {
    const noContent: LlmResponse = {};
    extractFunctionCallsFromResponse(noContent);
    expect(noContent.content).toBeUndefined();

    const emptyParts: LlmResponse = {content: {role: 'model', parts: []}};
    extractFunctionCallsFromResponse(emptyParts);
    expect(emptyParts.content?.parts).toHaveLength(0);

    const multipleParts: LlmResponse = {
      content: {
        role: 'model',
        parts: [createPartFromText('part one'), createPartFromText('part two')],
      },
    };
    const originalParts = [...(multipleParts.content?.parts ?? [])];
    extractFunctionCallsFromResponse(multipleParts);
    expect(multipleParts.content?.parts).toEqual(originalParts);

    const emptyTextPart = textResponse('');
    extractFunctionCallsFromResponse(emptyTextPart);
    expect(partsOf(emptyTextPart)[0].text).toBe('');
    expect(partsOf(emptyTextPart)[0].functionCall).toBeUndefined();
  });

  it('test_process_response_with_markdown_json_block', () => {
    const response = textResponse(
      '\n```json\n{"name": "search_web", "parameters": {"query": "latest news"}}\n```',
    );

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'latest news'},
    });
    expect(partsOf(response)[0].text).toBeUndefined();
  });

  it('test_process_response_with_markdown_tool_code_block', () => {
    const response = textResponse(
      '\nSome text before.\n```tool_code\n{"name": "get_current_time", "parameters": {}}\n```\nAnd some text after.',
    );

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].functionCall).toEqual({
      name: 'get_current_time',
      args: {},
    });
    expect(partsOf(response)[0].text).toBeUndefined();
  });

  it('test_process_response_with_embedded_json', () => {
    const response = textResponse(
      'Please call the tool: {"name": "search_web", "parameters": {"query": "new features"}} thanks!',
    );

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'new features'},
    });
    expect(partsOf(response)[0].text).toBeUndefined();
  });

  it('test_process_response_flexible_parsing', () => {
    const response = textResponse(
      '{"function": "do_something", "args": {"value": 123}}',
    );

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].functionCall).toEqual({
      name: 'do_something',
      args: {value: 123},
    });
    expect(partsOf(response)[0].text).toBeUndefined();
  });

  it('test_process_response_last_json_object', () => {
    const response = textResponse(
      'I thought about {"name": "first_call", "parameters": {"a": 1}} but then decided to call: {"name": "second_call", "parameters": {"b": 2}}',
    );

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].functionCall).toEqual({
      name: 'second_call',
      args: {b: 2},
    });
    expect(partsOf(response)[0].text).toBeUndefined();
  });

  it('test_process_response_skips_partial_streaming_chunk', () => {
    const text =
      '{"name": "search_web", "parameters": {"query": "latest news"}}';
    const response = textResponse(text, {partial: true});

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].text).toBe(text);
    expect(partsOf(response)[0].functionCall).toBeUndefined();
  });

  it('test_process_response_skips_turn_complete_marker', () => {
    const text =
      '{"name": "search_web", "parameters": {"query": "latest news"}}';
    const response = textResponse(text, {turnComplete: true});

    extractFunctionCallsFromResponse(response);

    expect(partsOf(response)).toHaveLength(1);
    expect(partsOf(response)[0].text).toBe(text);
    expect(partsOf(response)[0].functionCall).toBeUndefined();
  });

  it('test_gemma4_resolves_to_gemini_not_gemma', () => {
    const resolved = LLMRegistry.resolve('gemma-4-31b-it');

    expect(resolved).not.toBe(Gemma);
    expect(resolved).toBe(Gemini);
  });
});
