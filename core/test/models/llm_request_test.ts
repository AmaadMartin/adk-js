/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  insertTransientUserContent,
  LlmRequest,
} from '../../src/models/llm_request.js';

function makeRequest(contents: Content[]): LlmRequest {
  return {contents, liveConnectConfig: {}, toolsDict: {}};
}

function user(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function model(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function functionResponse(name: string): Content {
  return {
    role: 'user',
    parts: [{functionResponse: {name, response: {result: 'done'}}}],
  };
}

function roles(request: LlmRequest): Array<string | undefined> {
  return request.contents.map((content) => content.role);
}

function texts(request: LlmRequest): Array<string | undefined> {
  return request.contents.map((content) => content.parts?.[0]?.text);
}

describe('insertTransientUserContent', () => {
  it('leaves the request alone when there is nothing to insert', () => {
    const original = [user('current query')];
    const request = makeRequest(original);

    insertTransientUserContent(request, []);

    expect(request.contents).toBe(original);
    expect(request.contents).toHaveLength(1);
  });

  it('inserts at index 0 when the request has no contents', () => {
    const request = makeRequest([]);

    insertTransientUserContent(request, [user('recalled')]);

    expect(texts(request)).toEqual(['recalled']);
  });

  it('inserts before the trailing user content, after the model turn', () => {
    const request = makeRequest([
      user('historical question'),
      model('historical answer'),
      user('current query'),
    ]);

    insertTransientUserContent(request, [user('recalled')]);

    expect(roles(request)).toEqual(['user', 'model', 'user', 'user']);
    expect(texts(request)).toEqual([
      'historical question',
      'historical answer',
      'recalled',
      'current query',
    ]);
  });

  it('inserts before a whole trailing run of user contents', () => {
    const request = makeRequest([
      user('historical question'),
      model('historical answer'),
      user('first'),
      user('second'),
    ]);

    insertTransientUserContent(request, [user('recalled')]);

    expect(texts(request)).toEqual([
      'historical question',
      'historical answer',
      'recalled',
      'first',
      'second',
    ]);
  });

  it('inserts after a trailing function response', () => {
    const response = functionResponse('lookup');
    const request = makeRequest([
      user('current query'),
      model('calling'),
      response,
    ]);

    insertTransientUserContent(request, [user('recalled')]);

    expect(request.contents[2]).toBe(response);
    expect(texts(request)).toEqual([
      'current query',
      'calling',
      undefined,
      'recalled',
    ]);
  });

  it('inserts at index 0 when every content is a plain user content', () => {
    const request = makeRequest([user('first'), user('second')]);

    insertTransientUserContent(request, [user('recalled')]);

    expect(texts(request)).toEqual(['recalled', 'first', 'second']);
  });

  it('treats a trailing user content without parts as an ordinary turn', () => {
    const request = makeRequest([model('historical answer'), {role: 'user'}]);

    insertTransientUserContent(request, [user('recalled')]);

    expect(roles(request)).toEqual(['model', 'user', 'user']);
    expect(texts(request)).toEqual([
      'historical answer',
      'recalled',
      undefined,
    ]);
  });

  it('keeps the order of several inserted contents', () => {
    const request = makeRequest([
      model('historical answer'),
      user('current query'),
    ]);

    insertTransientUserContent(request, [user('first'), user('second')]);

    expect(texts(request)).toEqual([
      'historical answer',
      'first',
      'second',
      'current query',
    ]);
  });
});
