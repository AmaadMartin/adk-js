/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The whole invocation lifecycle over one `InMemoryRunner`: a session created
 * on demand, an invocation paused on a long-running tool call, a resume that
 * infers the invocation from the function response, and a rewind that undoes
 * both the state and the artifact the invocation wrote.
 */

import {
  createEvent,
  createResumabilityConfig,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'lifecycle_app';
const USER_ID = 'lifecycle_user';
const SESSION_ID = 'lifecycle_session';
const CALL_ID = 'fc-approval';

function textPart(text: string): Part {
  return {inlineData: {mimeType: 'text/plain', data: btoa(text)}};
}

/**
 * Asks for approval on the first turn, then records the answer in state and
 * writes an artifact.
 */
class ApprovalAgent extends LlmAgent {
  constructor() {
    super({name: 'approval_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const answered = context.session.events.some((event) =>
      (event.content?.parts ?? []).some(
        (part) => part.functionResponse?.id === CALL_ID,
      ),
    );
    if (!answered) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: CALL_ID, name: 'ask_approval', args: {}}},
          ],
        },
        longRunningToolIds: [CALL_ID],
      });
      return;
    }

    const artifactService = context.artifactService;
    if (!artifactService) {
      expect.fail('the invocation has no artifact service');
    }
    const version = await artifactService.saveArtifact({
      filename: 'decision.txt',
      artifact: textPart('approved'),
    });
    const event = createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'recorded the approval'}]},
    });
    event.actions.stateDelta['decision'] = 'approved';
    event.actions.artifactDelta['decision.txt'] = version;
    yield event;
  }
}

describe('Runner invocation lifecycle', () => {
  it('creates the session, resumes on a function response, then rewinds', async () => {
    const runner = new InMemoryRunner({
      appName: APP_NAME,
      agent: new ApprovalAgent(),
      autoCreateSession: true,
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });

    const {artifactService} = runner;
    if (!artifactService) {
      expect.fail('the in-memory runner has no artifact service');
    }

    const drain = async (newMessage?: Content): Promise<Event[]> => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage,
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await drain({role: 'user', parts: [{text: 'may I?'}]});
    const pausedInvocationId = first[0].invocationId;
    expect(
      first
        .flatMap((e) => e.content?.parts ?? [])
        .map((p) => p.functionCall?.id),
    ).toContain(CALL_ID);

    // The session did not exist before the run; autoCreateSession made it.
    const created = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(created?.id).toBe(SESSION_ID);

    // No invocation id is passed: it is inferred from the response id.
    const resumed = await drain({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: CALL_ID,
            name: 'ask_approval',
            response: {approved: true},
          },
        },
      ],
    });
    expect(resumed.every((e) => e.invocationId === pausedInvocationId)).toBe(
      true,
    );

    const afterResume = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(afterResume?.state['decision']).toBe('approved');
    expect(
      await artifactService.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'decision.txt',
      }),
    ).toEqual(textPart('approved'));

    await runner.rewindAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      rewindBeforeInvocationId: pausedInvocationId,
    });

    const afterRewind = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(afterRewind?.state['decision']).toBeNull();
    expect(afterRewind?.events.at(-1)?.actions.rewindBeforeInvocationId).toBe(
      pausedInvocationId,
    );
    expect(
      await artifactService.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'decision.txt',
      }),
    ).toEqual({inlineData: {mimeType: 'application/octet-stream', data: ''}});
  });
});
