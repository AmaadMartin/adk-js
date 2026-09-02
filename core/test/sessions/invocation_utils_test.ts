/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  findUserMessageForInvocation,
  InMemorySessionService,
  resolveInvocationIdFromFr,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'invocation_utils_app';
const USER_ID = 'invocation_utils_user';

function callEvent(invocationId: string, callIds: string[]): Event {
  return createEvent({
    invocationId,
    author: 'echo_agent',
    content: {
      role: 'model',
      parts: callIds.map((id) => ({
        functionCall: {id, name: 'ask', args: {}},
      })),
    },
  });
}

function userEvent(invocationId: string, content: Content): Event {
  return createEvent({invocationId, author: 'user', content});
}

function responseMessage(
  responses: Array<{id?: string; name?: string}>,
): Content {
  return {
    role: 'user',
    parts: responses.map(({id, name}) => ({
      functionResponse: {id, name: name ?? 'ask', response: {answer: 'yes'}},
    })),
  };
}

describe('resolveInvocationIdFromFr', () => {
  let session: Session;
  const sessionService = new InMemorySessionService();

  beforeEach(async () => {
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
  });

  it('resolves two responses that answer calls from one invocation', () => {
    session.events.push(callEvent('inv-1', ['fc-1', 'fc-2']));

    expect(
      resolveInvocationIdFromFr(
        session,
        responseMessage([{id: 'fc-1'}, {id: 'fc-2'}]),
      ),
    ).toBe('inv-1');
  });

  it('rejects responses that answer calls from two invocations', () => {
    session.events.push(callEvent('inv-1', ['fc-1']));
    session.events.push(callEvent('inv-2', ['fc-2']));

    expect(() =>
      resolveInvocationIdFromFr(
        session,
        responseMessage([{id: 'fc-1'}, {id: 'fc-2'}]),
      ),
    ).toThrow(/resolve to multiple invocations: inv-2,inv-1/);
  });

  it('rejects a response whose id matches no function call', () => {
    session.events.push(callEvent('inv-1', ['fc-1']));

    expect(() =>
      resolveInvocationIdFromFr(session, responseMessage([{id: 'fc-9'}])),
    ).toThrow(/Function call not found for function response ids: fc-9/);
  });

  it('returns nothing when the message carries no function response id', () => {
    expect(
      resolveInvocationIdFromFr(session, {
        role: 'user',
        parts: [{text: 'hello'}],
      }),
    ).toBeUndefined();
  });
});

describe('findUserMessageForInvocation', () => {
  it('finds a message whose text is not in the first part', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {inlineData: {mimeType: 'image/png', data: ''}},
        {text: 'what is this?'},
      ],
    };

    expect(
      findUserMessageForInvocation([userEvent('inv-1', content)], 'inv-1'),
    ).toBe(content);
  });

  it('skips a user event made only of function responses', () => {
    const events = [
      userEvent('inv-1', responseMessage([{id: 'fc-1'}])),
      userEvent('inv-1', {role: 'user', parts: [{text: 'the real one'}]}),
    ];

    expect(findUserMessageForInvocation(events, 'inv-1')?.parts).toEqual([
      {text: 'the real one'},
    ]);
  });

  it('returns nothing when no user message belongs to the invocation', () => {
    const events = [userEvent('inv-1', {role: 'user', parts: [{text: 'hi'}]})];

    expect(findUserMessageForInvocation(events, 'inv-2')).toBeUndefined();
  });

  it('skips a user event with no parts', () => {
    const events = [userEvent('inv-1', {role: 'user', parts: []})];

    expect(findUserMessageForInvocation(events, 'inv-1')).toBeUndefined();
  });
});
