/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  generateJsonText,
  isJsonObject,
  parseFencedJson,
} from '../../src/utils/llm_utils.js';

/** A model that replays `responses` and records the request it received. */
class ReplayLlm extends BaseLlm {
  request?: LlmRequest;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'replay-llm'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.request = llmRequest;
    yield* this.responses;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('A replay model does not support a live connection.');
  }
}

describe('generateJsonText', () => {
  it('concatenates the text of every part of every response', async () => {
    const llm = new ReplayLlm([
      {content: {role: 'model', parts: [{text: '{"a"'}, {text: ': 1,'}]}},
      {content: {role: 'model', parts: [{text: ' "b": 2}'}]}},
    ]);

    const text = await generateJsonText(llm, {}, 'give me json');

    expect(text).toBe('{"a": 1, "b": 2}');
  });

  it('skips a response that carries no content', async () => {
    const llm = new ReplayLlm([
      {},
      {content: {role: 'model', parts: [{text: '{}'}]}},
    ]);

    const text = await generateJsonText(llm, {}, 'give me json');

    expect(text).toBe('{}');
  });

  it('skips a part that carries no text', async () => {
    const llm = new ReplayLlm([
      {
        content: {
          role: 'model',
          parts: [
            {inlineData: {mimeType: 'image/png', data: 'AA=='}},
            {text: '{}'},
          ],
        },
      },
    ]);

    const text = await generateJsonText(llm, {}, 'give me json');

    expect(text).toBe('{}');
  });

  it("sends one user turn, the model's own name and a JSON response type", async () => {
    const llm = new ReplayLlm([]);

    await generateJsonText(llm, {temperature: 0.2}, 'give me json');

    expect(llm.request?.model).toBe('replay-llm');
    expect(llm.request?.contents).toEqual([
      {role: 'user', parts: [{text: 'give me json'}]},
    ]);
    expect(llm.request?.config).toEqual({
      temperature: 0.2,
      responseMimeType: 'application/json',
    });
  });
});

describe('parseFencedJson', () => {
  it.each([
    ['unfenced json', '{"a": 1}'],
    ['json in a tagged fence', '```json\n{"a": 1}\n```'],
    ['json in a bare fence', '```\n{"a": 1}\n```'],
    ['a fence with a trailing newline', '```json\n{"a": 1}\n```\n'],
    ['json wrapped in whitespace', '  \n{"a": 1}\n  '],
  ])('parses %s', (_, text) => {
    expect(parseFencedJson(text)).toEqual({a: 1});
  });

  it('parses a JSON value that is not an object', () => {
    expect(parseFencedJson('[1, 2]')).toEqual([1, 2]);
    expect(parseFencedJson('null')).toBeNull();
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseFencedJson('sorry, I cannot do that')).toBeUndefined();
  });
});

describe('isJsonObject', () => {
  it('accepts a JSON object', () => {
    expect(isJsonObject({a: 1})).toBe(true);
  });

  it.each([
    ['an array', [1, 2]],
    ['null', null],
    ['a number', 42],
    ['a string', 'a string'],
    ['undefined', undefined],
  ])('rejects %s', (_, value) => {
    expect(isJsonObject(value)).toBe(false);
  });
});
