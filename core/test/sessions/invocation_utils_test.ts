/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession, Event, Session} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  extractResumeInputs,
  findUserMessageForInvocation,
  getFunctionResponsesFromContent,
  resolveInvocationId,
  resolveInvocationIdFromFunctionResponses,
  validateNewMessage,
} from '../../src/sessions/invocation_utils.js';
import {logger} from '../../src/utils/logger.js';

function callEvent(params: {invocationId: string; callIds: string[]}): Event {
  return createEvent({
    invocationId: params.invocationId,
    author: 'agent',
    content: {
      role: 'model',
      parts: params.callIds.map((id) => ({
        functionCall: {id, name: 'book', args: {}},
      })),
    },
  });
}

function responseMessage(ids: Array<string | undefined>): Content {
  return {
    role: 'user',
    parts: ids.map((id) => ({
      functionResponse: {id, name: 'book', response: {ok: true}},
    })),
  };
}

function sessionOf(events: Event[]): Session {
  return createSession({id: 's1', appName: 'app', userId: 'u', events});
}

describe('getFunctionResponsesFromContent', () => {
  it('returns an empty list for a message with no parts', () => {
    expect(getFunctionResponsesFromContent(undefined)).toEqual([]);
    expect(getFunctionResponsesFromContent({role: 'user'})).toEqual([]);
  });

  it('returns only the function response parts', () => {
    const responses = getFunctionResponsesFromContent({
      role: 'user',
      parts: [{text: 'hi'}, {functionResponse: {id: 'fc-1', name: 'book'}}],
    });

    expect(responses).toEqual([{id: 'fc-1', name: 'book'}]);
  });
});

describe('extractResumeInputs', () => {
  it('keys each tool result by the call it answers', () => {
    expect(extractResumeInputs(responseMessage(['fc-1', 'fc-2']))).toEqual({
      'fc-1': {ok: true},
      'fc-2': {ok: true},
    });
  });

  it('returns undefined for a plain text message', () => {
    expect(
      extractResumeInputs({role: 'user', parts: [{text: 'hello'}]}),
    ).toBeUndefined();
  });

  it('returns undefined when a response carries no id', () => {
    expect(extractResumeInputs(responseMessage([undefined]))).toBeUndefined();
  });

  it('returns undefined for an absent message', () => {
    expect(extractResumeInputs(undefined)).toBeUndefined();
  });
});

describe('validateNewMessage', () => {
  it('rejects a message mixing function responses with text', () => {
    const message: Content = {
      role: 'user',
      parts: [
        {functionResponse: {id: 'fc-1', name: 'book', response: {ok: true}}},
        {text: 'and also book a hotel'},
      ],
    };

    expect(() =>
      validateNewMessage(message, extractResumeInputs(message)),
    ).toThrow(/cannot contain both function responses and text/);
  });

  it('accepts a message of function responses only', () => {
    const message = responseMessage(['fc-1']);

    expect(() =>
      validateNewMessage(message, extractResumeInputs(message)),
    ).not.toThrow();
  });

  it('accepts a plain text message', () => {
    const message: Content = {role: 'user', parts: [{text: 'hello'}]};

    expect(() => validateNewMessage(message, undefined)).not.toThrow();
  });

  it('accepts resume inputs with no message to check against', () => {
    expect(() => validateNewMessage(undefined, {'fc-1': {}})).not.toThrow();
    expect(() =>
      validateNewMessage({role: 'user'}, {'fc-1': {}}),
    ).not.toThrow();
  });
});

describe('resolveInvocationIdFromFunctionResponses', () => {
  it('resolves the invocation that issued the answered call', () => {
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1']}),
    ]);

    expect(
      resolveInvocationIdFromFunctionResponses(
        session,
        responseMessage(['fc-1']),
      ),
    ).toBe('inv-1');
  });

  it('resolves several responses answering calls from one invocation', () => {
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1', 'fc-2']}),
    ]);

    expect(
      resolveInvocationIdFromFunctionResponses(
        session,
        responseMessage(['fc-1', 'fc-2']),
      ),
    ).toBe('inv-1');
  });

  it('rejects responses that span two invocations', () => {
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1']}),
      callEvent({invocationId: 'inv-2', callIds: ['fc-2']}),
    ]);

    expect(() =>
      resolveInvocationIdFromFunctionResponses(
        session,
        responseMessage(['fc-1', 'fc-2']),
      ),
    ).toThrow(/resolve to multiple invocations/);
  });

  it('rejects a response whose call is not in the session', () => {
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1']}),
    ]);

    expect(() =>
      resolveInvocationIdFromFunctionResponses(
        session,
        responseMessage(['fc-9']),
      ),
    ).toThrow(/Function call not found for function response ids: fc-9/);
  });

  it('returns undefined when the message carries no function responses', () => {
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1']}),
    ]);

    expect(
      resolveInvocationIdFromFunctionResponses(session, {
        role: 'user',
        parts: [{text: 'hello'}],
      }),
    ).toBeUndefined();
  });
});

describe('resolveInvocationId', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the caller id for an absent message', () => {
    expect(resolveInvocationId(sessionOf([]), undefined, 'inv-7')).toBe(
      'inv-7',
    );
  });

  it('returns the caller id for a plain text message', () => {
    expect(
      resolveInvocationId(
        sessionOf([]),
        {role: 'user', parts: [{text: 'hello'}]},
        'inv-7',
      ),
    ).toBe('inv-7');
  });

  it('rejects a function response with no id', () => {
    expect(() =>
      resolveInvocationId(
        sessionOf([]),
        responseMessage([undefined]),
        undefined,
      ),
    ).toThrow('Function response id is required to resume an invocation.');
  });

  it('warns and prefers the resolved id over a disagreeing caller id', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1']}),
    ]);

    expect(
      resolveInvocationId(session, responseMessage(['fc-1']), 'inv-other'),
    ).toBe('inv-1');
    expect(warn).toHaveBeenCalledWith(
      'Provided invocationId inv-other is ignored because newMessage has a ' +
        'function response with invocationId inv-1.',
    );
  });

  it('stays silent when the caller id agrees with the responses', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const session = sessionOf([
      callEvent({invocationId: 'inv-1', callIds: ['fc-1']}),
    ]);

    expect(
      resolveInvocationId(session, responseMessage(['fc-1']), 'inv-1'),
    ).toBe('inv-1');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('findUserMessageForInvocation', () => {
  it('finds a message whose text is not the first part', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {inlineData: {mimeType: 'image/png', data: 'aGk='}},
        {text: 'what is in this picture?'},
      ],
    };
    const events = [
      createEvent({invocationId: 'inv-1', author: 'user', content}),
    ];

    expect(findUserMessageForInvocation(events, 'inv-1')).toEqual(content);
  });

  it('finds an image-only message', () => {
    const content: Content = {
      role: 'user',
      parts: [{inlineData: {mimeType: 'image/png', data: 'aGk='}}],
    };
    const events = [
      createEvent({invocationId: 'inv-1', author: 'user', content}),
    ];

    expect(findUserMessageForInvocation(events, 'inv-1')).toEqual(content);
  });

  it('skips an event made only of function responses', () => {
    const text: Content = {role: 'user', parts: [{text: 'book a flight'}]};
    const events = [
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: responseMessage(['fc-1']),
      }),
      createEvent({invocationId: 'inv-1', author: 'user', content: text}),
    ];

    expect(findUserMessageForInvocation(events, 'inv-1')).toEqual(text);
  });

  it('ignores events from another invocation and from the agent', () => {
    const events = [
      createEvent({
        invocationId: 'inv-2',
        author: 'user',
        content: {role: 'user', parts: [{text: 'other turn'}]},
      }),
      createEvent({
        invocationId: 'inv-1',
        author: 'agent',
        content: {role: 'model', parts: [{text: 'reply'}]},
      }),
      createEvent({invocationId: 'inv-1', author: 'user'}),
    ];

    expect(findUserMessageForInvocation(events, 'inv-1')).toBeUndefined();
  });
});
