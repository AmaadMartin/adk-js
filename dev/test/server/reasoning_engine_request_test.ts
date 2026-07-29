/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {parseReasoningEngineQuery} from '../../src/server/reasoning_engine_request.js';

const NEW_MESSAGE: Content = {role: 'user', parts: [{text: 'Hello'}]};

describe('parseReasoningEngineQuery', () => {
  it('reads the fields from the top level of the body', () => {
    const query = parseReasoningEngineQuery({
      appName: 'testApp',
      userId: 'testUser',
      sessionId: 'testSession',
      newMessage: NEW_MESSAGE,
      stateDelta: {counter: 1},
    });

    expect(query).toEqual({
      appName: 'testApp',
      userId: 'testUser',
      sessionId: 'testSession',
      newMessage: NEW_MESSAGE,
      stateDelta: {counter: 1},
    });
  });

  it('reads the fields from input, which wins over the top level', () => {
    const query = parseReasoningEngineQuery({
      appName: 'bodyApp',
      userId: 'bodyUser',
      sessionId: 'bodySession',
      newMessage: {role: 'user', parts: [{text: 'from body'}]},
      stateDelta: {source: 'body'},
      input: {
        appName: 'inputApp',
        userId: 'inputUser',
        sessionId: 'inputSession',
        newMessage: NEW_MESSAGE,
        stateDelta: {source: 'input'},
      },
    });

    expect(query).toEqual({
      appName: 'inputApp',
      userId: 'inputUser',
      sessionId: 'inputSession',
      newMessage: NEW_MESSAGE,
      stateDelta: {source: 'input'},
    });
  });

  it('defaults the user and session when they are missing', () => {
    const query = parseReasoningEngineQuery({appName: 'testApp'});

    expect(query.userId).toBe('default-user');
    expect(query.sessionId).toBe('default-session');
  });

  it('treats an empty string as missing', () => {
    const query = parseReasoningEngineQuery({
      appName: '',
      userId: '',
      sessionId: '',
    });

    expect(query.appName).toBeUndefined();
    expect(query.userId).toBe('default-user');
    expect(query.sessionId).toBe('default-session');
  });

  it('falls back to the top level when input holds an empty string', () => {
    const query = parseReasoningEngineQuery({
      appName: 'bodyApp',
      userId: 'bodyUser',
      sessionId: 'bodySession',
      input: {appName: '', userId: '', sessionId: ''},
    });

    expect(query).toMatchObject({
      appName: 'bodyApp',
      userId: 'bodyUser',
      sessionId: 'bodySession',
    });
  });

  for (const value of [42, {nested: true}, null]) {
    it(`ignores the non-string identifiers ${JSON.stringify(value)}`, () => {
      const query = parseReasoningEngineQuery({
        appName: value,
        userId: value,
        sessionId: value,
      });

      expect(query.appName).toBeUndefined();
      expect(query.userId).toBe('default-user');
      expect(query.sessionId).toBe('default-session');
    });
  }

  for (const value of [
    'hello',
    42,
    ['a'],
    {parts: 'x'},
    {parts: ['not a part']},
    {role: 5},
  ]) {
    it(`rejects the malformed newMessage ${JSON.stringify(value)}`, () => {
      const query = parseReasoningEngineQuery({newMessage: value});

      expect(query.newMessage).toBeUndefined();
    });
  }

  it('keeps a well formed newMessage', () => {
    const query = parseReasoningEngineQuery({newMessage: NEW_MESSAGE});

    expect(query.newMessage).toEqual(NEW_MESSAGE);
  });

  for (const value of [['a'], 'text', 7]) {
    it(`rejects the non-object stateDelta ${JSON.stringify(value)}`, () => {
      const query = parseReasoningEngineQuery({stateDelta: value});

      expect(query.stateDelta).toBeUndefined();
    });
  }

  for (const body of [undefined, null, '{}', [], 7]) {
    it(`returns the defaults for the non-object body ${JSON.stringify(body)}`, () => {
      const query = parseReasoningEngineQuery(body);

      expect(query).toEqual({
        appName: undefined,
        userId: 'default-user',
        sessionId: 'default-session',
        newMessage: undefined,
        stateDelta: undefined,
      });
    });
  }

  it('ignores an input that is not an object', () => {
    const query = parseReasoningEngineQuery({
      input: 'nope',
      appName: 'testApp',
    });

    expect(query).toMatchObject({
      appName: 'testApp',
      userId: 'default-user',
      sessionId: 'default-session',
    });
  });
});
