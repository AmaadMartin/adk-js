/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  collectFunctionCallIds,
  resolveFunctionResponseId,
  userMessageToContent,
} from '../../src/integration/user_message_utils.js';

describe('userMessageToContent', () => {
  it('wraps the text of a message in a user content', () => {
    expect(userMessageToContent({text: 'hello'})).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('marks a supplied content as coming from the user', () => {
    expect(userMessageToContent({content: {parts: [{text: 'hello'}]}})).toEqual(
      {role: 'user', parts: [{text: 'hello'}]},
    );
  });

  it('rejects a message that carries neither text nor content', () => {
    expect(() => userMessageToContent({})).toThrow(
      'Either Content text or content field is required',
    );
  });
});

describe('resolveFunctionResponseId', () => {
  it('gives the response the id of the call it answers', () => {
    const content = {
      role: 'user',
      parts: [{functionResponse: {name: 'approve', response: {ok: true}}}],
    };

    resolveFunctionResponseId(content, new Map([['approve', 'call-1']]));

    expect(content.parts[0].functionResponse).toMatchObject({id: 'call-1'});
  });

  it('leaves a message that carries no function response alone', () => {
    const content = {role: 'user', parts: [{text: 'hello'}]};

    resolveFunctionResponseId(content, new Map());

    expect(content).toEqual({role: 'user', parts: [{text: 'hello'}]});
  });

  it('rejects a response that answers no pending call', () => {
    const content = {
      role: 'user',
      parts: [{functionResponse: {name: 'approve', response: {ok: true}}}],
    };

    expect(() => resolveFunctionResponseId(content, new Map())).toThrow(
      'Function response for approve does not match any pending function call.',
    );
  });
});

describe('collectFunctionCallIds', () => {
  it('records the id of every named function call of an event', () => {
    const pending = new Map<string, string>();

    collectFunctionCallIds(
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'call-1', name: 'approve', args: {}}},
            {functionCall: {name: 'unidentified', args: {}}},
            {text: 'thinking'},
          ],
        },
      }),
      pending,
    );

    expect([...pending]).toEqual([['approve', 'call-1']]);
  });

  it('ignores an event with no content', () => {
    const pending = new Map<string, string>();

    collectFunctionCallIds(createEvent({author: 'agent'}), pending);

    expect(pending.size).toBe(0);
  });
});
