/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  GenerateContentResponse,
  GoogleGenAI,
  Tool,
  Type,
} from '@google/genai';
import {describe, expect, it} from 'vitest';

// Internal transform helpers are not part of the public API, so they (and the
// request/response types they operate on) are imported from source directly,
// mirroring the other model unit tests (e.g. gemini_llm_connection_test.ts).
import {
  buildGemmaFunctionSystemInstruction,
  convertContentPartsForGemma,
  extractFunctionCallsFromResponse,
  Gemma,
  getLastValidJsonSubstring,
  moveFunctionCallsIntoSystemInstruction,
  moveSystemInstructionToUserContent,
  parseGemmaFunctionCall,
  preprocessGemmaRequest,
} from '../../src/models/gemma_llm.js';
import {Gemini} from '../../src/models/google_llm.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {LLMRegistry} from '../../src/models/registry.js';

function makeRequest(overrides: Partial<LlmRequest>): LlmRequest {
  return {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function makeResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

const searchWebTool: Tool = {
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

describe('Gemma registry routing', () => {
  it('resolves gemma-3-* to the Gemma class', () => {
    expect(LLMRegistry.resolve('gemma-3-27b-it')).toBe(Gemma);
  });

  it('resolves gemma-4-* to the native Gemini class, not Gemma', () => {
    const resolved = LLMRegistry.resolve('gemma-4-31b-it');
    expect(resolved).toBe(Gemini);
    expect(resolved).not.toBe(Gemma);
  });

  it('still resolves gemini-* to the Gemini class', () => {
    expect(LLMRegistry.resolve('gemini-2.5-flash')).toBe(Gemini);
  });

  it('advertises the gemma-.* supported model pattern', () => {
    expect(Gemma.supportedModels.map(String)).toContain('/gemma-.*/');
  });
});

describe('Gemma constructor', () => {
  it('defaults the model to gemma-3-27b-it', () => {
    expect(new Gemma({apiKey: 'test-key'}).model).toBe('gemma-3-27b-it');
  });

  it('honours an explicit gemma model', () => {
    expect(new Gemma({apiKey: 'test-key', model: 'gemma-3-12b-it'}).model).toBe(
      'gemma-3-12b-it',
    );
  });

  it('forces the Gemini API backend', () => {
    expect(new Gemma({apiKey: 'test-key'}).apiBackend).toBe('GEMINI_API');
  });
});

describe('Gemma.generateContentAsync guard', () => {
  it('throws when the request model is not a Gemma model', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const request = makeRequest({model: 'not-a-gemma-model'});

    await expect(async () => {
      for await (const _ of gemma.generateContentAsync(request)) {
        // no-op: the guard should throw before yielding.
      }
    }).rejects.toThrow(/model/);
  });
});

describe('preprocessGemmaRequest (system instruction + tools)', () => {
  it('moves the system instruction into a leading user content', () => {
    const request = makeRequest({
      model: 'gemma-3-4b-it',
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {systemInstruction: 'You are a helpful assistant'},
    });

    preprocessGemmaRequest(request);

    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].role).toBe('user');
    expect(request.contents[0].parts?.[0].text).toBe(
      'You are a helpful assistant',
    );
    expect(request.contents[1].parts?.[0].text).toBe('Hello');
  });

  it('does not duplicate an instruction already at the front', () => {
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [
        {role: 'user', parts: [{text: 'Talk like a pirate.'}]},
        {role: 'user', parts: [{text: 'Hello'}]},
      ],
      config: {systemInstruction: 'Talk like a pirate.'},
    });

    preprocessGemmaRequest(request);

    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].parts?.[0].text).toBe('Talk like a pirate.');
  });

  it('injects tool declarations into a leading user content and clears tools', () => {
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {tools: [searchWebTool]},
    });

    preprocessGemmaRequest(request);

    expect(request.config?.tools).toEqual([]);
    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toHaveLength(2);
    expect(request.contents[1].role).toBe('user');
    expect(request.contents[1].parts?.[0].text).toBe('Hello');

    const sysText = request.contents[0].parts?.[0].text;
    expect(sysText).toContain('You have access to the following functions');
    expect(sysText).toContain('"name":"search_web"');
    expect(sysText).toContain('"name":"get_current_time"');
  });
});

describe('moveFunctionCallsIntoSystemInstruction (history conversion)', () => {
  it('converts a function response into a user text content', () => {
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

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.contents).toHaveLength(1);
    expect(request.contents[0].role).toBe('user');
    expect(request.contents[0].parts?.[0].text).toBe(
      'Invoking tool `search_web` produced: `{"results":[{"title":"ADK"}]}`.',
    );
    expect(request.contents[0].parts?.[0].functionResponse).toBeUndefined();
    expect(request.contents[0].parts?.[0].functionCall).toBeUndefined();
  });

  it('converts a function call into a model text content', () => {
    const functionCall = {name: 'get_current_time', args: {}};
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [{role: 'user', parts: [{functionCall}]}],
    });

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.contents).toHaveLength(1);
    expect(request.contents[0].role).toBe('model');
    expect(request.contents[0].parts?.[0].text).toBe(
      JSON.stringify(functionCall),
    );
    expect(request.contents[0].parts?.[0].functionCall).toBeUndefined();
    expect(request.contents[0].parts?.[0].functionResponse).toBeUndefined();
  });

  it('handles mixed content while preserving order and roles', () => {
    const functionCall = {name: 'get_weather', args: {city: 'London'}};
    const request = makeRequest({
      model: 'gemma-3-1b-it',
      contents: [
        {role: 'user', parts: [{text: 'Hello!'}]},
        {role: 'model', parts: [{functionCall}]},
        {
          role: 'some_function',
          parts: [
            {functionResponse: {name: 'get_weather', response: {temp: '15C'}}},
          ],
        },
        {role: 'user', parts: [{text: 'How are you?'}]},
      ],
    });

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.contents).toHaveLength(4);

    expect(request.contents[0].role).toBe('user');
    expect(request.contents[0].parts?.[0].text).toBe('Hello!');

    expect(request.contents[1].role).toBe('model');
    expect(request.contents[1].parts?.[0].text).toBe(
      JSON.stringify(functionCall),
    );

    expect(request.contents[2].role).toBe('user');
    expect(request.contents[2].parts?.[0].text).toBe(
      'Invoking tool `get_weather` produced: `{"temp":"15C"}`.',
    );

    expect(request.contents[3].role).toBe('user');
    expect(request.contents[3].parts?.[0].text).toBe('How are you?');
  });

  it('clears tools without an instruction when there are no declarations', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {tools: [{googleSearch: {}}, {functionDeclarations: []}]},
    });

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.config?.tools).toEqual([]);
    expect(request.config?.systemInstruction).toBeUndefined();
  });

  it('leaves an undefined config untouched', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    });

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.config).toBeUndefined();
    expect(request.contents).toHaveLength(1);
  });
});

describe('convertContentPartsForGemma', () => {
  it('passes through content that has no parts', () => {
    const result = convertContentPartsForGemma({role: 'user'});
    expect(result.parts).toEqual([]);
    expect(result.hasFunctionResponse).toBe(false);
    expect(result.hasFunctionCall).toBe(false);
  });

  it('passes through plain text parts unchanged', () => {
    const part = {text: 'plain'};
    const result = convertContentPartsForGemma({role: 'user', parts: [part]});
    expect(result.parts).toEqual([part]);
    expect(result.hasFunctionResponse).toBe(false);
    expect(result.hasFunctionCall).toBe(false);
  });
});

describe('buildGemmaFunctionSystemInstruction', () => {
  it('returns an empty string for no declarations', () => {
    expect(buildGemmaFunctionSystemInstruction([])).toBe('');
  });

  it('serializes declarations and appends the format instructions', () => {
    const result = buildGemmaFunctionSystemInstruction([
      {name: 'do_thing', description: 'Does a thing.'},
    ]);
    expect(result).toContain('You have access to the following functions:\n[');
    expect(result).toContain('"name":"do_thing"');
    expect(result).toContain(
      'When you call a function, you MUST respond in the format of:',
    );
    expect(result).toContain(
      'When you call a function, you MUST NOT include any other text in the response.\n',
    );
  });
});

describe('moveSystemInstructionToUserContent', () => {
  it('is a no-op when there is no system instruction', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [{text: 'hi'}]}],
      config: {},
    });
    moveSystemInstructionToUserContent(request);
    expect(request.contents).toHaveLength(1);
  });

  it('clears the instruction without prepending when there are no contents', () => {
    const request = makeRequest({
      contents: [],
      config: {systemInstruction: 'be nice'},
    });
    moveSystemInstructionToUserContent(request);
    expect(request.contents).toEqual([]);
    expect(request.config?.systemInstruction).toBeUndefined();
  });

  it('prepends when the first content is not a user turn', () => {
    const request = makeRequest({
      contents: [{role: 'model', parts: [{text: 'hi'}]}],
      config: {systemInstruction: 'sys'},
    });
    moveSystemInstructionToUserContent(request);
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].parts?.[0].text).toBe('sys');
  });

  it('prepends when the first user turn has multiple parts', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [{text: 'a'}, {text: 'b'}]}],
      config: {systemInstruction: 'sys'},
    });
    moveSystemInstructionToUserContent(request);
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].parts?.[0].text).toBe('sys');
  });

  it('prepends when the first user turn has no parts', () => {
    const request = makeRequest({
      contents: [{role: 'user'}],
      config: {systemInstruction: 'sys'},
    });
    moveSystemInstructionToUserContent(request);
    expect(request.contents).toHaveLength(2);
    expect(request.contents[0].parts?.[0].text).toBe('sys');
  });
});

describe('extractFunctionCallsFromResponse', () => {
  it('parses a plain JSON function call and clears the text', () => {
    const response = makeResponse(
      '{"name": "search_web", "parameters": {"query": "latest news"}}',
    );

    extractFunctionCallsFromResponse(response);

    expect(response.content?.parts).toHaveLength(1);
    expect(response.content?.parts?.[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'latest news'},
    });
    expect(response.content?.parts?.[0].text).toBeUndefined();
  });

  it('leaves plain (non-JSON) text unchanged', () => {
    const response = makeResponse('This is a regular text response.');
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].text).toBe(
      'This is a regular text response.',
    );
    expect(response.content?.parts?.[0].functionCall).toBeUndefined();
  });

  it('leaves valid JSON that is not a function call unchanged', () => {
    const text = '{"not_a_function": "value", "another_field": 123}';
    const response = makeResponse(text);
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].text).toBe(text);
    expect(response.content?.parts?.[0].functionCall).toBeUndefined();
  });

  it('is a no-op when there is no content', () => {
    const response: LlmResponse = {content: undefined};
    extractFunctionCallsFromResponse(response);
    expect(response.content).toBeUndefined();
  });

  it('is a no-op for an empty parts list', () => {
    const response: LlmResponse = {content: {role: 'model', parts: []}};
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts).toEqual([]);
  });

  it('is a no-op for multi-part responses', () => {
    const response: LlmResponse = {
      content: {role: 'model', parts: [{text: 'one'}, {text: 'two'}]},
    };
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts).toHaveLength(2);
    expect(response.content?.parts?.[0].text).toBe('one');
    expect(response.content?.parts?.[1].text).toBe('two');
  });

  it('is a no-op for an empty-text single part', () => {
    const response = makeResponse('');
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].text).toBe('');
    expect(response.content?.parts?.[0].functionCall).toBeUndefined();
  });

  it('parses a markdown ```json``` block', () => {
    const response = makeResponse(
      '\n```json\n{"name": "search_web", "parameters": {"query": "latest news"}}\n```',
    );
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'latest news'},
    });
    expect(response.content?.parts?.[0].text).toBeUndefined();
  });

  it('parses a markdown ```tool_code``` block surrounded by prose', () => {
    const response = makeResponse(
      'Some text before.\n```tool_code\n{"name": "get_current_time", "parameters": {}}\n```\nAnd some text after.',
    );
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toEqual({
      name: 'get_current_time',
      args: {},
    });
    expect(response.content?.parts?.[0].text).toBeUndefined();
  });

  it('parses JSON embedded in surrounding prose', () => {
    const response = makeResponse(
      'Please call the tool: {"name": "search_web", "parameters": {"query": "new features"}} thanks!',
    );
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'new features'},
    });
  });

  it('parses flexible function/args aliases', () => {
    const response = makeResponse(
      '{"function": "do_something", "args": {"value": 123}}',
    );
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toEqual({
      name: 'do_something',
      args: {value: 123},
    });
  });

  it('chooses the last valid JSON object when several are present', () => {
    const response = makeResponse(
      'I thought about {"name": "first_call", "parameters": {"a": 1}} but then' +
        ' decided to call: {"name": "second_call", "parameters": {"b": 2}}',
    );
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toEqual({
      name: 'second_call',
      args: {b: 2},
    });
  });

  it('leaves the response unchanged when a markdown block holds invalid JSON', () => {
    const text = '```json\nnot valid json\n```';
    const response = makeResponse(text);
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].text).toBe(text);
    expect(response.content?.parts?.[0].functionCall).toBeUndefined();
  });

  it('skips partial responses', () => {
    const response: LlmResponse = {
      ...makeResponse('{"name": "search_web", "parameters": {}}'),
      partial: true,
    };
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toBeUndefined();
    expect(response.content?.parts?.[0].text).toBe(
      '{"name": "search_web", "parameters": {}}',
    );
  });

  it('skips turn-complete responses', () => {
    const response: LlmResponse = {
      ...makeResponse('{"name": "search_web", "parameters": {}}'),
      turnComplete: true,
    };
    extractFunctionCallsFromResponse(response);
    expect(response.content?.parts?.[0].functionCall).toBeUndefined();
  });
});

describe('getLastValidJsonSubstring', () => {
  it('returns null when there is no brace', () => {
    expect(getLastValidJsonSubstring('hello world')).toBeNull();
  });

  it('returns null for balanced but invalid JSON', () => {
    expect(getLastValidJsonSubstring('{a: 1}')).toBeNull();
  });

  it('returns null for an unclosed object', () => {
    expect(getLastValidJsonSubstring('{"a": 1')).toBeNull();
  });

  it('ignores braces inside string literals', () => {
    expect(getLastValidJsonSubstring('{"k": "}"}')).toBe('{"k": "}"}');
  });

  it('handles escaped quotes inside string literals', () => {
    expect(getLastValidJsonSubstring('{"k": "a\\"b"}')).toBe('{"k": "a\\"b"}');
  });

  it('extracts a nested object', () => {
    expect(getLastValidJsonSubstring('prefix {"a": {"b": 1}} suffix')).toBe(
      '{"a": {"b": 1}}',
    );
  });
});

describe('parseGemmaFunctionCall', () => {
  it('returns null for non-object values', () => {
    expect(parseGemmaFunctionCall(42)).toBeNull();
    expect(parseGemmaFunctionCall(null)).toBeNull();
    expect(parseGemmaFunctionCall('str')).toBeNull();
  });

  it('returns null when the name alias is missing', () => {
    expect(parseGemmaFunctionCall({parameters: {}})).toBeNull();
  });

  it('returns null when the name is not a string', () => {
    expect(parseGemmaFunctionCall({name: 123, parameters: {}})).toBeNull();
  });

  it('returns null when the args alias is missing', () => {
    expect(parseGemmaFunctionCall({name: 'x'})).toBeNull();
  });

  it('returns null when the args value is an array', () => {
    expect(parseGemmaFunctionCall({name: 'x', parameters: [1, 2]})).toBeNull();
  });

  it('accepts the name/parameters aliases', () => {
    expect(parseGemmaFunctionCall({name: 'x', parameters: {a: 1}})).toEqual({
      name: 'x',
      args: {a: 1},
    });
  });

  it('accepts the function/args aliases', () => {
    expect(parseGemmaFunctionCall({function: 'y', args: {b: 2}})).toEqual({
      name: 'y',
      args: {b: 2},
    });
  });
});

describe('Gemma.generateContentAsync end-to-end (mocked backend)', () => {
  function mockGemma(response: GenerateContentResponse): {
    gemma: Gemma;
    captured: {contents?: Content[]; config?: Record<string, unknown>};
  } {
    const gemma = new Gemma({apiKey: 'test-key'});
    const captured: {contents?: Content[]; config?: Record<string, unknown>} =
      {};

    const mockClient = {
      vertexai: false,
      models: {
        async generateContent(req: {
          contents?: Content[];
          config?: Record<string, unknown>;
        }): Promise<GenerateContentResponse> {
          captured.contents = req.contents;
          captured.config = req.config;
          return response;
        },
        async generateContentStream(): Promise<
          AsyncGenerator<GenerateContentResponse>
        > {
          return (async function* () {
            yield response;
          })();
        },
      },
    };

    Object.defineProperty(gemma, 'apiClient', {
      get: () => mockClient as unknown as GoogleGenAI,
    });

    return {gemma, captured};
  }

  function makeGenerateContentResponse(text: string): GenerateContentResponse {
    const response = new GenerateContentResponse();
    response.candidates = [{content: {role: 'model', parts: [{text}]}}];
    return response;
  }

  it('preprocesses a tool request and surfaces a text-JSON reply as a functionCall', async () => {
    const {gemma, captured} = mockGemma(
      makeGenerateContentResponse(
        '{"name": "search_web", "parameters": {"query": "latest news"}}',
      ),
    );

    const request = makeRequest({
      model: 'gemma-3-27b-it',
      contents: [{role: 'user', parts: [{text: 'find news'}]}],
      config: {tools: [searchWebTool]},
    });

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(request)) {
      responses.push(response);
    }

    // Preprocessing: tools cleared and moved into a leading user content.
    expect(captured.config?.['tools']).toEqual([]);
    expect(captured.config?.['systemInstruction']).toBeUndefined();
    expect(captured.contents?.[0].role).toBe('user');
    expect(captured.contents?.[0].parts?.[0].text).toContain(
      'You have access to the following functions',
    );
    expect(captured.contents?.[1].parts?.[0].text).toBe('find news');

    // Response: the text-JSON function call is surfaced as a structured part.
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'latest news'},
    });
  });

  it('defaults to the instance model when the request omits one', async () => {
    const {gemma} = mockGemma(
      makeGenerateContentResponse('Just a text reply.'),
    );

    const request = makeRequest({
      contents: [{role: 'user', parts: [{text: 'hi'}]}],
    });

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBe('Just a text reply.');
    expect(responses[0].content?.parts?.[0].functionCall).toBeUndefined();
  });
});
