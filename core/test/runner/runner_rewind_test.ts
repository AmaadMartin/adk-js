/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  Session,
  SessionNotFoundError,
} from '@google/adk';
import {Part} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'runner_rewind_app';
const USER_ID = 'rewind_user';
const SESSION_ID = 'rewind_session';
const MISSING_SESSION_ID = 'missing_rewind_session';

class EchoAgent extends LlmAgent {
  constructor() {
    super({name: 'echo_agent', model: 'gemini-2.5-flash'});
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

function textPart(text: string): Part {
  return {inlineData: {mimeType: 'text/plain', data: btoa(text)}};
}

describe('Runner.rewindAsync', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let session: Session;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  function createRunner(autoCreateSession = false): Runner {
    return new Runner({
      appName: APP_NAME,
      agent: new EchoAgent(),
      sessionService,
      artifactService,
      autoCreateSession,
    });
  }

  it('undoes the state and artifacts an invocation wrote', async () => {
    await artifactService.saveArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'notes.txt',
      artifact: textPart('first'),
    });
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        actions: createEventActions({
          stateDelta: {topic: 'weather'},
          artifactDelta: {'notes.txt': 0},
        }),
      }),
    });
    await artifactService.saveArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'notes.txt',
      artifact: textPart('second'),
    });
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-2',
        author: 'user',
        actions: createEventActions({
          stateDelta: {topic: 'traffic', extra: 'added'},
          artifactDelta: {'notes.txt': 1},
        }),
      }),
    });

    await createRunner().rewindAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      rewindBeforeInvocationId: 'inv-2',
    });

    const reloaded = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(reloaded?.state).toEqual({topic: 'weather', extra: null});
    expect(
      await artifactService.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'notes.txt',
      }),
    ).toEqual(textPart('first'));
    const rewindEvent = reloaded?.events.at(-1);
    expect(rewindEvent?.actions.rewindBeforeInvocationId).toBe('inv-2');
  });

  it('rejects an invocation the session does not contain', async () => {
    await sessionService.appendEvent({
      session,
      event: createEvent({invocationId: 'inv-1', author: 'user'}),
    });

    await expect(
      createRunner().rewindAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        rewindBeforeInvocationId: 'inv-9',
      }),
    ).rejects.toThrow('Invocation ID not found: inv-9');
  });

  it('reports a missing session rather than rewinding nothing', async () => {
    await expect(
      createRunner().rewindAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        rewindBeforeInvocationId: 'inv-1',
      }),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('creates a missing session first when autoCreateSession is set', async () => {
    await expect(
      createRunner(true).rewindAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        rewindBeforeInvocationId: 'inv-1',
      }),
    ).rejects.toThrow('Invocation ID not found: inv-1');

    const created = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: MISSING_SESSION_ID,
    });
    expect(created?.id).toBe(MISSING_SESSION_ID);
  });
});
