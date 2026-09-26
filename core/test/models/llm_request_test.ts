/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest} from '@google/adk';
import {Content, createModelContent, createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {insertTransientUserContent} from '../../src/models/llm_request.js';

function createRequest(contents: Content[]): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}, config: {}};
}

const FUNCTION_RESPONSE_CONTENT: Content = {
  role: 'user',
  parts: [{functionResponse: {name: 'lookup', response: {result: 'done'}}}],
};

describe('insertTransientUserContent', () => {
  it('leaves the request untouched when there is nothing to insert', () => {
    const request = createRequest([createUserContent('current query')]);

    insertTransientUserContent(request, []);

    expect(request.contents).toEqual([createUserContent('current query')]);
  });

  it('inserts at index 0 when the request has no contents', () => {
    const request = createRequest([]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents).toEqual([createUserContent('memory')]);
  });

  it('inserts before a history of only user contents', () => {
    const request = createRequest([
      createUserContent('first'),
      createUserContent('second'),
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[0]).toEqual(createUserContent('memory'));
    expect(request.contents).toHaveLength(3);
  });

  it('inserts after the last model content', () => {
    const request = createRequest([
      createUserContent('historical question'),
      createModelContent('historical answer'),
      createUserContent('current query'),
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[2]).toEqual(createUserContent('memory'));
    expect(request.contents[3]).toEqual(createUserContent('current query'));
  });

  it('inserts after a trailing function response', () => {
    const request = createRequest([
      createUserContent('current query'),
      createModelContent({functionCall: {name: 'lookup', args: {}}}),
      FUNCTION_RESPONSE_CONTENT,
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[2]).toBe(FUNCTION_RESPONSE_CONTENT);
    expect(request.contents[3]).toEqual(createUserContent('memory'));
  });

  it('walks past a user content that has no parts', () => {
    const request = createRequest([
      createModelContent('historical answer'),
      {role: 'user'},
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[1]).toEqual(createUserContent('memory'));
    expect(request.contents[2]).toEqual({role: 'user'});
  });

  it('keeps the relative order of several inserted contents', () => {
    const request = createRequest([createUserContent('current query')]);

    insertTransientUserContent(request, [
      createUserContent('first'),
      createUserContent('second'),
    ]);

    expect(request.contents).toEqual([
      createUserContent('first'),
      createUserContent('second'),
      createUserContent('current query'),
    ]);
  });

  it('mutates the contents array in place', () => {
    const contents = [createUserContent('current query')];
    const request = createRequest(contents);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents).toBe(contents);
    expect(contents).toHaveLength(2);
  });
});
