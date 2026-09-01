/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {isEqual} from 'lodash-es';

import {newInvocationContextId} from '../agents/invocation_context.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {createEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {logger} from '../utils/logger.js';
import {BaseSessionService} from './base_session_service.js';
import {Session} from './session.js';

/** Prefixes of state keys that outlive a single session, so a rewind skips them. */
const SHARED_STATE_PREFIXES = ['app:', 'user:'];

/** The placeholder written for an artifact that did not exist at the rewind point. */
const EMPTY_ARTIFACT: Part = {
  inlineData: {mimeType: 'application/octet-stream', data: ''},
};

/** Computes the state delta that puts the session back to the rewind point. */
export function computeStateDeltaForRewind(
  session: Session,
  rewindEventIndex: number,
): Record<string, unknown> {
  const stateAtRewindPoint: Record<string, unknown> = {};
  for (const event of session.events.slice(0, rewindEventIndex)) {
    for (const [key, value] of Object.entries(event.actions.stateDelta)) {
      if (isSharedStateKey(key)) {
        continue;
      }
      if (value === null || value === undefined) {
        delete stateAtRewindPoint[key];
      } else {
        stateAtRewindPoint[key] = value;
      }
    }
  }

  const currentState = session.state;
  const rewindStateDelta: Record<string, unknown> = {};
  for (const [key, valueAtRewind] of Object.entries(stateAtRewindPoint)) {
    if (!(key in currentState) || !isEqual(currentState[key], valueAtRewind)) {
      rewindStateDelta[key] = valueAtRewind;
    }
  }
  for (const key of Object.keys(currentState)) {
    if (!isSharedStateKey(key) && !(key in stateAtRewindPoint)) {
      rewindStateDelta[key] = null;
    }
  }
  return rewindStateDelta;
}

/**
 * Computes the artifact delta that puts the session back to the rewind point,
 * restoring each affected artifact's contents as it goes.
 *
 * An artifact that did not exist at the rewind point, or whose contents can no
 * longer be loaded, is replaced with an empty blob rather than left at its
 * later version.
 */
export async function computeArtifactDeltaForRewind(
  session: Session,
  rewindEventIndex: number,
  options: {artifactService?: BaseArtifactService; appName: string},
): Promise<Record<string, number>> {
  const {artifactService, appName} = options;
  if (!artifactService) {
    return {};
  }

  const versionsAtRewindPoint = accumulateArtifactVersions(
    session.events.slice(0, rewindEventIndex),
  );
  const currentVersions = accumulateArtifactVersions(session.events);

  const sessionKey = {
    appName,
    userId: session.userId,
    sessionId: session.id,
  };
  const rewindArtifactDelta: Record<string, number> = {};
  for (const [filename, currentVersion] of Object.entries(currentVersions)) {
    // User artifacts outlive the session, so a rewind leaves them alone.
    if (filename.startsWith('user:')) {
      continue;
    }
    const versionAtRewindPoint = versionsAtRewindPoint[filename];
    if (versionAtRewindPoint === currentVersion) {
      continue;
    }

    rewindArtifactDelta[filename] = currentVersion + 1;
    await artifactService.saveArtifact({
      ...sessionKey,
      filename,
      artifact: await loadArtifactAtRewindPoint(
        artifactService,
        {...sessionKey, filename},
        versionAtRewindPoint,
      ),
    });
  }
  return rewindArtifactDelta;
}

/**
 * Rewinds the session to before an invocation: it appends one event carrying
 * the state and artifact deltas that undo everything from that invocation on.
 *
 * @throws {Error} When no event in the session belongs to the invocation.
 */
export async function rewindSession(params: {
  sessionService: BaseSessionService;
  session: Session;
  rewindBeforeInvocationId: string;
  artifactService?: BaseArtifactService;
  appName: string;
}): Promise<void> {
  const {session, rewindBeforeInvocationId} = params;
  const rewindEventIndex = session.events.findIndex(
    (event) => event.invocationId === rewindBeforeInvocationId,
  );
  if (rewindEventIndex === -1) {
    throw new Error(`Invocation ID not found: ${rewindBeforeInvocationId}`);
  }

  const stateDelta = computeStateDeltaForRewind(session, rewindEventIndex);
  const artifactDelta = await computeArtifactDeltaForRewind(
    session,
    rewindEventIndex,
    {artifactService: params.artifactService, appName: params.appName},
  );

  await params.sessionService.appendEvent({
    session,
    event: createEvent({
      invocationId: newInvocationContextId(),
      author: 'user',
      actions: createEventActions({
        rewindBeforeInvocationId,
        stateDelta,
        artifactDelta,
      }),
    }),
  });
}

function isSharedStateKey(key: string): boolean {
  return SHARED_STATE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function accumulateArtifactVersions(
  events: Session['events'],
): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const event of events) {
    Object.assign(versions, event.actions.artifactDelta);
  }
  return versions;
}

async function loadArtifactAtRewindPoint(
  artifactService: BaseArtifactService,
  key: {appName: string; userId: string; sessionId: string; filename: string},
  versionAtRewindPoint: number | undefined,
): Promise<Part> {
  if (versionAtRewindPoint === undefined) {
    return EMPTY_ARTIFACT;
  }
  const loaded = await artifactService.loadArtifact({
    ...key,
    version: versionAtRewindPoint,
  });
  if (!loaded) {
    logger.warn(
      `Artifact ${key.filename} version ${versionAtRewindPoint} not found ` +
        `during rewind for session ${key.sessionId}. Replacing with empty data.`,
    );
    return EMPTY_ARTIFACT;
  }
  return loaded;
}
