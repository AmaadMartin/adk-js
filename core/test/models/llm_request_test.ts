/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createModelContent, createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  insertTransientUserContent,
  LlmRequest,
} from '../../src/models/llm_request.js';

function createRequest(contents: Content[]): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

function texts(request: LlmRequest): Array<string | undefined> {
  return request.contents.map((content) => content.parts?.[0]?.text);
}

describe('insertTransientUserContent', () => {
  it('leaves the contents untouched when there is nothing to insert', () => {
    const request = createRequest([createUserContent('question')]);

    insertTransientUserContent(request, []);

    expect(texts(request)).toEqual(['question']);
  });

  it('inserts before the latest run of user contents', () => {
    const request = createRequest([
      createUserContent('older question'),
      createModelContent('answer'),
      createUserContent('question'),
      createUserContent('follow-up'),
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(texts(request)).toEqual([
      'older question',
      'answer',
      'instruction',
      'question',
      'follow-up',
    ]);
  });

  it('inserts after a user content that carries a function response', () => {
    const request = createRequest([
      createUserContent('question'),
      createModelContent([
        {functionCall: {id: 'call_1', name: 'tool', args: {}}},
      ]),
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'tool',
              response: {ok: true},
            },
          },
        ],
      },
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(request.contents).toHaveLength(4);
    expect(request.contents[2].parts?.[0]?.functionResponse?.id).toBe('call_1');
    expect(request.contents[3].parts?.[0]?.text).toBe('instruction');
  });

  it('appends at the end when the last content is a model turn', () => {
    const request = createRequest([
      createUserContent('question'),
      createModelContent('answer'),
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(texts(request)).toEqual(['question', 'answer', 'instruction']);
  });

  it('inserts at the start when every content is an ordinary user turn', () => {
    const request = createRequest([
      createUserContent('question'),
      createUserContent('follow-up'),
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(texts(request)).toEqual(['instruction', 'question', 'follow-up']);
  });

  it('keeps the order of several inserted contents', () => {
    const request = createRequest([createUserContent('question')]);

    insertTransientUserContent(request, [
      createUserContent('first'),
      createUserContent('second'),
    ]);

    expect(texts(request)).toEqual(['first', 'second', 'question']);
  });
});
