/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, TaskArtifactUpdateEvent} from '@a2a-js/sdk';
import {AgentExecutionEvent} from '@a2a-js/sdk/server';
import {Part as GenAIPart} from '@google/genai';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {Event as AdkEvent} from '../events/event.js';
import {createTaskArtifactUpdateEvent} from './a2a_event.js';
import {ExecutorContext} from './executor_context.js';
import {toA2APart} from './part_converter_utils.js';

/**
 * Converts a stored artifact to an A2A part, or `undefined` when the artifact
 * carries nothing A2A can represent.
 *
 * `toA2APart` is total, so an unrepresentable artifact has to be recognised
 * from what it converts to: a blob with no payload, or an empty data part.
 * Publishing either would announce an artifact the peer cannot read.
 */
function toArtifactPart(artifact: GenAIPart): A2APart | undefined {
  if (artifact.inlineData && artifact.inlineData.data == null) {
    return undefined;
  }

  const part = toA2APart(artifact);

  return part.kind === 'data' && Object.keys(part.data).length === 0
    ? undefined
    : part;
}

/**
 * Loads one artifact version and wraps it in its own A2A artifact update.
 *
 * Returns `undefined` when the version is gone or carries no representable
 * payload.
 */
async function toArtifactEvent(
  artifactService: BaseArtifactService,
  ctx: ExecutorContext,
  a2aEvent: TaskArtifactUpdateEvent,
  filename: string,
  version: number,
): Promise<TaskArtifactUpdateEvent | undefined> {
  const artifact = await artifactService.loadArtifact({
    appName: ctx.appName,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    filename,
    version,
  });
  const part = artifact && toArtifactPart(artifact);
  if (!part) {
    return undefined;
  }

  return createTaskArtifactUpdateEvent({
    taskId: a2aEvent.taskId,
    contextId: a2aEvent.contextId,
    artifactId: `${filename}_${version}`,
    name: filename,
    parts: [part],
    metadata: a2aEvent.metadata,
    append: false,
    lastChunk: true,
  });
}

/**
 * An `afterEventCallback` that publishes the artifacts an ADK event saved.
 *
 * Install it on `AgentExecutorConfig.afterEventCallback` to have every
 * artifact recorded in `actions.artifactDelta` loaded from the runner's
 * artifact service and emitted as its own A2A artifact update, so a remote
 * peer receives the files the agent produced. Without it the artifacts stay in
 * the artifact service and the peer never learns about them.
 *
 * @param ctx The executor context, which supplies the artifact scope and the
 *     artifact service.
 * @param adkEvent The ADK event that produced the converted A2A event.
 * @param a2aEvent The converted A2A event.
 * @returns The converted event followed by one artifact update per artifact,
 *     or the converted event alone when there is nothing to publish.
 */
export async function includeArtifactsInA2AEvent(
  ctx: ExecutorContext,
  adkEvent: AdkEvent,
  a2aEvent?: TaskArtifactUpdateEvent,
): Promise<AgentExecutionEvent | AgentExecutionEvent[] | undefined> {
  if (!a2aEvent) {
    return undefined;
  }

  const artifactService = ctx.artifactService;
  if (!artifactService) {
    return a2aEvent;
  }

  const artifactEvents = (
    await Promise.all(
      Object.entries(adkEvent.actions.artifactDelta).map(
        ([filename, version]) =>
          toArtifactEvent(artifactService, ctx, a2aEvent, filename, version),
      ),
    )
  ).filter((event): event is TaskArtifactUpdateEvent => event !== undefined);

  return artifactEvents.length > 0 ? [a2aEvent, ...artifactEvents] : a2aEvent;
}
