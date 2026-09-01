/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeArtifactDeltaForRewind,
  computeStateDeltaForRewind,
  createEvent,
  createEventActions,
  InMemoryArtifactService,
  InMemorySessionService,
  rewindSession,
  Session,
} from '@google/adk';
import {Part} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'rewind_app';
const USER_ID = 'rewind_user';

function textPart(text: string): Part {
  return {inlineData: {mimeType: 'text/plain', data: btoa(text)}};
}

describe('computeStateDeltaForRewind', () => {
  let sessionService: InMemorySessionService;
  let session: Session;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
  });

  async function append(
    invocationId: string,
    stateDelta: Record<string, unknown>,
  ): Promise<void> {
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId,
        author: 'user',
        actions: createEventActions({stateDelta}),
      }),
    });
  }

  it('restores a changed key and clears one added after the rewind point', async () => {
    await append('inv-1', {kept: 'first', changed: 'before'});
    await append('inv-2', {changed: 'after', addedLater: 'new'});

    expect(computeStateDeltaForRewind(session, 1)).toEqual({
      changed: 'before',
      addedLater: null,
    });
  });

  it('leaves app: and user: keys untouched', async () => {
    await append('inv-1', {'app:shared': 'one'});
    await append('inv-2', {'app:shared': 'two', 'user:pref': 'dark'});

    expect(computeStateDeltaForRewind(session, 1)).toEqual({});
  });

  it('keeps a key deleted before the rewind point deleted', async () => {
    await append('inv-1', {gone: 'value'});
    await append('inv-2', {gone: null});
    await append('inv-3', {gone: 'back'});

    expect(computeStateDeltaForRewind(session, 2)).toEqual({gone: null});
  });

  it('leaves an unchanged object-valued key out of the delta', async () => {
    await append('inv-1', {profile: {city: 'Paris'}});
    await append('inv-2', {other: 'added'});
    // A session service that persists rebuilds state from storage, so the
    // current value is an equal object rather than the one the event carried.
    session.state['profile'] = {city: 'Paris'};

    expect(computeStateDeltaForRewind(session, 1)).toEqual({
      other: null,
    });
  });

  it('produces nothing when no state changed after the rewind point', async () => {
    await append('inv-1', {kept: 'first'});
    await append('inv-2', {});

    expect(computeStateDeltaForRewind(session, 1)).toEqual({});
  });
});

describe('computeArtifactDeltaForRewind', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let session: Session;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
  });

  async function saveArtifact(filename: string, text: string): Promise<number> {
    return artifactService.saveArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      filename,
      artifact: textPart(text),
    });
  }

  async function append(
    invocationId: string,
    artifactDelta: Record<string, number>,
  ): Promise<void> {
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId,
        author: 'user',
        actions: createEventActions({artifactDelta}),
      }),
    });
  }

  function loadLatest(filename: string): Promise<Part | undefined> {
    return artifactService.loadArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      filename,
    });
  }

  it('produces nothing without an artifact service', async () => {
    await append('inv-1', {'report.txt': 0});

    expect(
      await computeArtifactDeltaForRewind(session, 1, {appName: APP_NAME}),
    ).toEqual({});
  });

  it('leaves an artifact unchanged across the rewind point alone', async () => {
    await saveArtifact('report.txt', 'v0');
    await append('inv-1', {'report.txt': 0});
    await append('inv-2', {});

    expect(
      await computeArtifactDeltaForRewind(session, 1, {
        artifactService,
        appName: APP_NAME,
      }),
    ).toEqual({});
  });

  it('restores the version an artifact had at the rewind point', async () => {
    await saveArtifact('report.txt', 'v0');
    await append('inv-1', {'report.txt': 0});
    await saveArtifact('report.txt', 'v1');
    await append('inv-2', {'report.txt': 1});

    expect(
      await computeArtifactDeltaForRewind(session, 1, {
        artifactService,
        appName: APP_NAME,
      }),
    ).toEqual({'report.txt': 2});
    expect(await loadLatest('report.txt')).toEqual(textPart('v0'));
  });

  it('writes an empty blob for an artifact that did not exist yet', async () => {
    await append('inv-1', {});
    await saveArtifact('late.txt', 'v0');
    await append('inv-2', {'late.txt': 0});

    expect(
      await computeArtifactDeltaForRewind(session, 1, {
        artifactService,
        appName: APP_NAME,
      }),
    ).toEqual({'late.txt': 1});
    expect(await loadLatest('late.txt')).toEqual({
      inlineData: {mimeType: 'application/octet-stream', data: ''},
    });
  });

  it('skips a user-scoped artifact', async () => {
    await append('inv-1', {});
    await append('inv-2', {'user:profile.txt': 3});

    expect(
      await computeArtifactDeltaForRewind(session, 1, {
        artifactService,
        appName: APP_NAME,
      }),
    ).toEqual({});
  });

  it('warns and substitutes an empty blob when the version cannot be loaded', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await append('inv-1', {'ghost.txt': 4});
    await append('inv-2', {'ghost.txt': 5});

    expect(
      await computeArtifactDeltaForRewind(session, 1, {
        artifactService,
        appName: APP_NAME,
      }),
    ).toEqual({'ghost.txt': 6});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Artifact ghost.txt version 4 not found'),
    );
    expect(await loadLatest('ghost.txt')).toEqual({
      inlineData: {mimeType: 'application/octet-stream', data: ''},
    });
    warn.mockRestore();
  });
});

describe('rewindSession', () => {
  let sessionService: InMemorySessionService;
  let session: Session;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        actions: createEventActions({stateDelta: {step: 'one'}}),
      }),
    });
  });

  it('rejects an invocation id that is not in the session', async () => {
    await expect(
      rewindSession({
        sessionService,
        session,
        rewindBeforeInvocationId: 'inv-missing',
        appName: APP_NAME,
      }),
    ).rejects.toThrow('Invocation ID not found: inv-missing');
  });

  it('appends one rewind event carrying both deltas', async () => {
    await rewindSession({
      sessionService,
      session,
      rewindBeforeInvocationId: 'inv-1',
      appName: APP_NAME,
    });

    expect(session.events).toHaveLength(2);
    const rewindEvent = session.events[1];
    expect(rewindEvent.author).toBe('user');
    expect(rewindEvent.invocationId).toMatch(/^e-/);
    expect(rewindEvent.actions.rewindBeforeInvocationId).toBe('inv-1');
    expect(rewindEvent.actions.stateDelta).toEqual({step: null});
    expect(rewindEvent.actions.artifactDelta).toEqual({});
  });
});
