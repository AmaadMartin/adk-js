/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the Gemma behaviour the ported adk-python tests in
 * `gemma_llm_test.ts` do not reach: the class defaults, the two error paths of
 * the response parser, and the edges of the JSON scanner.
 */

import {Gemma, GoogleLLMVariant, LlmRequest, LlmResponse} from '@google/adk';
import {createPartFromText, Tool} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  buildGemmaFunctionSystemInstruction,
  convertContentPartsForGemma,
  extractFunctionCallsFromResponse,
  getLastValidJsonSubstring,
  moveFunctionCallsIntoSystemInstruction,
  moveSystemInstructionToUserContent,
} from '../../src/models/gemma_llm.js';
import {logger} from '../../src/utils/logger.js';

const TEST_API_KEY = 'test-key';

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function textResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [createPartFromText(text)]}};
}

function responseTextOf(llmResponse: LlmResponse): string | undefined {
  return llmResponse.content?.parts?.[0].text;
}

describe('Gemma', () => {
  const clearEnv = () => {
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_GENAI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
    delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
  };

  beforeEach(clearEnv);
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it('defaults to the recommended Gemma 3 model', () => {
    expect(new Gemma({apiKey: TEST_API_KEY}).model).toBe('gemma-3-27b-it');
  });

  it('keeps the model the caller names', () => {
    expect(
      new Gemma({apiKey: TEST_API_KEY, model: 'gemma-3-12b-it'}).model,
    ).toBe('gemma-3-12b-it');
  });

  it('serves every request through the Gemini API backend', () => {
    const llm = new Gemma({
      vertexai: true,
      project: 'a-project',
      location: 'us-central1',
    });

    expect(llm.apiBackend).toBe(GoogleLLMVariant.GEMINI_API);
  });

  it('rejects a non-Gemma model named by the instance', async () => {
    const llm = new Gemma({apiKey: TEST_API_KEY, model: 'gemini-2.5-flash'});

    const run = async () => {
      for await (const response of llm.generateContentAsync(makeRequest())) {
        expect.fail(`expected no response, got ${JSON.stringify(response)}`);
      }
    };

    await expect(run()).rejects.toThrow(
      'Requesting a non-Gemma model (gemini-2.5-flash) with the Gemma LLM is not supported.',
    );
  });
});

describe('moveFunctionCallsIntoSystemInstruction', () => {
  it('empties tools that declare no function', () => {
    const searchTool: Tool = {googleSearch: {}};
    const request = makeRequest({config: {tools: [searchTool]}});

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.config?.tools).toEqual([]);
    expect(request.config?.systemInstruction).toBeUndefined();
  });

  it('leaves a request without tools alone', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [createPartFromText('Hello')]}],
      config: {},
    });

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.config?.tools).toBeUndefined();
    expect(request.contents).toHaveLength(1);
  });

  it('appends the tool instruction after an existing one', () => {
    const tool: Tool = {
      functionDeclarations: [{name: 'ping', description: 'Pings.'}],
    };
    const request = makeRequest({
      config: {systemInstruction: 'Be brief.', tools: [tool]},
    });

    moveFunctionCallsIntoSystemInstruction(request);

    expect(request.config?.systemInstruction).toBe(
      'Be brief.\n\nYou have access to the following functions:\n' +
        '[{"name":"ping","description":"Pings."}\n]\n' +
        'When you call a function, you MUST respond in the format of: ' +
        '{"name": function name, "parameters": dictionary of argument name and its value}\n' +
        'When you call a function, you MUST NOT include any other text in the response.\n',
    );
  });
});

describe('convertContentPartsForGemma', () => {
  it('reports no conversion for a content without parts', () => {
    expect(convertContentPartsForGemma({role: 'user'})).toEqual({
      parts: [],
      hasFunctionResponse: false,
      hasFunctionCall: false,
    });
  });

  it('serializes a tool result the way Python json.dumps does', () => {
    const {parts} = convertContentPartsForGemma({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_all',
            response: {
              count: 2,
              ok: true,
              missing: null,
              dropped: undefined,
              rows: [['a', 1], []],
            },
          },
        },
      ],
    });

    expect(parts[0].text).toBe(
      'Invoking tool `read_all` produced: ' +
        '`{"count": 2, "ok": true, "missing": null, "rows": [["a", 1], []]}`.',
    );
  });

  it('writes a null for an undefined array item, as Python does', () => {
    const {parts} = convertContentPartsForGemma({
      role: 'user',
      parts: [
        {functionResponse: {name: 'sparse', response: {rows: [undefined]}}},
      ],
    });

    expect(parts[0].text).toBe(
      'Invoking tool `sparse` produced: `{"rows": [null]}`.',
    );
  });
});

describe('buildGemmaFunctionSystemInstruction', () => {
  it('returns an empty instruction for no declarations', () => {
    expect(buildGemmaFunctionSystemInstruction([])).toBe('');
  });
});

describe('moveSystemInstructionToUserContent', () => {
  it('leaves a request without config alone', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [createPartFromText('Hello')]}],
    });

    moveSystemInstructionToUserContent(request);

    expect(request.contents).toHaveLength(1);
  });

  it('leaves an empty instruction alone', () => {
    const request = makeRequest({config: {systemInstruction: ''}});

    moveSystemInstructionToUserContent(request);

    expect(request.config?.systemInstruction).toBe('');
    expect(request.contents).toHaveLength(0);
  });

  it('leaves an instruction that is not text alone', () => {
    const request = makeRequest({
      contents: [{role: 'user', parts: [createPartFromText('Hello')]}],
      config: {
        systemInstruction: {role: 'system', parts: [{text: 'Be brief.'}]},
      },
    });

    moveSystemInstructionToUserContent(request);

    expect(request.config?.systemInstruction).toEqual({
      role: 'system',
      parts: [{text: 'Be brief.'}],
    });
    expect(request.contents).toHaveLength(1);
  });

  it('clears the instruction of a request that has no contents', () => {
    const request = makeRequest({config: {systemInstruction: 'Be brief.'}});

    moveSystemInstructionToUserContent(request);

    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toHaveLength(0);
  });
});

describe('extractFunctionCallsFromResponse', () => {
  it('logs and keeps the text when a fenced block is not JSON', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const text = '```json\n{name: search_web}\n```';
    const response = textResponse(text);

    extractFunctionCallsFromResponse(response);

    expect(responseTextOf(response)).toBe(text);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error attempting to parse JSON'),
    );
  });

  it('logs and keeps the text when the JSON names no function', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const text = '{"name": 123, "parameters": {}}';
    const response = textResponse(text);

    extractFunctionCallsFromResponse(response);

    expect(responseTextOf(response)).toBe(text);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a Gemma function call'),
    );
  });

  it('keeps the text when the arguments are an array', () => {
    const text = '{"name": "search_web", "parameters": ["latest news"]}';
    const response = textResponse(text);

    extractFunctionCallsFromResponse(response);

    expect(responseTextOf(response)).toBe(text);
  });

  it('keeps the text when a fenced block holds a JSON array', () => {
    const text = '```json\n[1, 2]\n```';
    const response = textResponse(text);

    extractFunctionCallsFromResponse(response);

    expect(responseTextOf(response)).toBe(text);
  });

  it('keeps the text when a fenced block is empty', () => {
    const text = '```json\n\n```';
    const response = textResponse(text);

    extractFunctionCallsFromResponse(response);

    expect(responseTextOf(response)).toBe(text);
  });

  it('warns instead of throwing when the response cannot be rewritten', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const response = textResponse('{"name": "search_web", "parameters": {}}');
    // A frozen content makes the rewrite throw a TypeError, which is neither a
    // syntax error nor a shape mismatch.
    Object.freeze(response.content);

    extractFunctionCallsFromResponse(response);

    expect(responseTextOf(response)).toBe(
      '{"name": "search_web", "parameters": {}}',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error processing Gemma function call response'),
    );
  });
});

describe('getLastValidJsonSubstring', () => {
  it('returns null for a text without an object', () => {
    expect(getLastValidJsonSubstring('no braces here')).toBeNull();
  });

  it('returns null for an object that never closes', () => {
    expect(getLastValidJsonSubstring('{"a": 1')).toBeNull();
  });

  it('ignores braces inside a string literal', () => {
    expect(getLastValidJsonSubstring('{"a": "} not the end"}')).toBe(
      '{"a": "} not the end"}',
    );
  });

  it('ignores an escaped quote inside a string literal', () => {
    expect(getLastValidJsonSubstring('{"a": "say \\"hi\\" }"}')).toBe(
      '{"a": "say \\"hi\\" }"}',
    );
  });

  it('skips a balanced object that is not valid JSON', () => {
    expect(getLastValidJsonSubstring('{a: 1} then {"b": 2}')).toBe('{"b": 2}');
  });

  it('finds an object nested in an invalid one', () => {
    expect(getLastValidJsonSubstring('{"a": {"b": 1} c}')).toBe('{"b": 1}');
  });
});
