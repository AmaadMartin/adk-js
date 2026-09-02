/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createResumabilityConfig,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'resume_app';
const USER_ID = 'resume_user';
const SESSION_ID = 'resume_session';

class EchoAgent extends LlmAgent {
  constructor(name = 'echo_agent') {
    super({name, model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }
}

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

describe('Runner invocation resumption', () => {
  let sessionService: InMemorySessionService;
  let session: Session;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  function createRunner(isResumable: boolean): Runner {
    return new Runner({
      appName: APP_NAME,
      agent: new EchoAgent(),
      sessionService,
      resumabilityConfig: createResumabilityConfig({isResumable}),
    });
  }

  async function drain(
    runner: Runner,
    params: {invocationId?: string; newMessage?: Content},
  ): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      ...params,
    })) {
      events.push(event);
    }
    return events;
  }

  async function reload(): Promise<Session> {
    const reloaded = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    if (!reloaded) {
      expect.fail('the session disappeared');
    }
    return reloaded;
  }

  it('stamps a caller-supplied invocationId on every event', async () => {
    const events = await drain(createRunner(false), {
      invocationId: 'caller-inv',
      newMessage: {role: 'user', parts: [{text: 'hello'}]},
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.invocationId === 'caller-inv')).toBe(true);
  });

  it('resumes the invocation the function responses belong to', async () => {
    await sessionService.appendEvent({
      session,
      event: userEvent('inv-1', {role: 'user', parts: [{text: 'start'}]}),
    });
    await sessionService.appendEvent({
      session,
      event: callEvent('inv-1', ['fc-1']),
    });

    const events = await drain(createRunner(true), {
      newMessage: responseMessage([{id: 'fc-1'}]),
    });

    expect(events.every((e) => e.invocationId === 'inv-1')).toBe(true);
  });

  it('rejects a function response that carries no id', async () => {
    await sessionService.appendEvent({
      session,
      event: callEvent('inv-1', ['fc-1']),
    });

    await expect(
      drain(createRunner(true), {newMessage: responseMessage([{}])}),
    ).rejects.toThrow(
      'Function response id is required to resume an invocation.',
    );
  });

  it('rejects a message whose second function response has no id', async () => {
    await sessionService.appendEvent({
      session,
      event: callEvent('inv-1', ['fc-1']),
    });

    await expect(
      drain(createRunner(true), {
        newMessage: responseMessage([{id: 'fc-1'}, {}]),
      }),
    ).rejects.toThrow(
      'Function response id is required to resume an invocation.',
    );
  });

  it('warns and prefers the resolved invocation over the supplied one', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await sessionService.appendEvent({
      session,
      event: userEvent('inv-1', {role: 'user', parts: [{text: 'start'}]}),
    });
    await sessionService.appendEvent({
      session,
      event: callEvent('inv-1', ['fc-1']),
    });

    const events = await drain(createRunner(true), {
      invocationId: 'inv-other',
      newMessage: responseMessage([{id: 'fc-1'}]),
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring the provided invocationId inv-other'),
    );
    expect(events.every((e) => e.invocationId === 'inv-1')).toBe(true);
    warn.mockRestore();
  });

  it('rejects a run with neither a newMessage nor an invocationId', async () => {
    await expect(drain(createRunner(true), {})).rejects.toThrow(
      /requires either a newMessage or an invocationId/,
    );
  });

  it('rejects a run with no newMessage on an app that is not resumable', async () => {
    await expect(
      drain(createRunner(false), {invocationId: 'inv-1'}),
    ).rejects.toThrow(/requires a newMessage or a resumable app/);
  });

  it('rejects resuming a session that has no events', async () => {
    await expect(
      drain(createRunner(true), {invocationId: 'inv-1'}),
    ).rejects.toThrow(`Session ${SESSION_ID} has no events to resume.`);
  });

  it('rejects resuming when no user message can be found', async () => {
    await sessionService.appendEvent({
      session,
      event: callEvent('inv-1', ['fc-1']),
    });

    await expect(
      drain(createRunner(true), {invocationId: 'inv-2'}),
    ).rejects.toThrow(
      'No user message available for resuming invocation: inv-2',
    );
  });

  it('does not append a second user event when resuming without a message', async () => {
    await sessionService.appendEvent({
      session,
      event: userEvent('inv-1', {role: 'user', parts: [{text: 'start'}]}),
    });

    await drain(createRunner(true), {invocationId: 'inv-1'});

    const authors = (await reload()).events.map((e) => e.author);
    expect(authors).toEqual(['user', 'echo_agent']);
  });

  it('appends the reply when resuming with a function response', async () => {
    await sessionService.appendEvent({
      session,
      event: userEvent('inv-1', {role: 'user', parts: [{text: 'start'}]}),
    });
    await sessionService.appendEvent({
      session,
      event: callEvent('inv-1', ['fc-1']),
    });

    await drain(createRunner(true), {
      newMessage: responseMessage([{id: 'fc-1'}]),
    });

    const events = (await reload()).events;
    expect(events.map((e) => e.author)).toEqual([
      'user',
      'echo_agent',
      'user',
      'echo_agent',
    ]);
    expect(events[2].content?.parts?.[0].functionResponse?.id).toBe('fc-1');
  });

  it('warns and drops a second user message for an invocation already opened', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await sessionService.appendEvent({
      session,
      event: userEvent('inv-1', {role: 'user', parts: [{text: 'start'}]}),
    });

    await drain(createRunner(true), {
      invocationId: 'inv-1',
      newMessage: {role: 'user', parts: [{text: 'start again'}]},
    });

    const authors = (await reload()).events.map((e) => e.author);
    expect(authors).toEqual(['user', 'echo_agent']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropping the new message for invocation inv-1'),
    );
    warn.mockRestore();
  });
});
