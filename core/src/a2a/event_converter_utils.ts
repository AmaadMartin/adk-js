/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  CitationMetadata,
  createModelContent,
  createUserContent,
  Part as GenAIPart,
  GroundingMetadata,
  UsageMetadata,
} from '@google/genai';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {
  A2AEvent,
  createTaskArtifactUpdateEvent,
  getEventMetadata,
  getFailedTaskStatusUpdateEventError,
  isFailedTaskStatusUpdateEvent,
  isInputRequiredTaskStatusUpdateEvent,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
  isTerminalTaskStatusUpdateEvent,
  MessageRole,
} from './a2a_event.js';
import {ExecutorContext} from './executor_context.js';
import {
  A2AMetadataKeys,
  getA2AEventMetadata,
} from './metadata_converter_utils.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
  toA2APart,
  toA2AParts,
  toGenAIPart,
  toGenAIParts,
} from './part_converter_utils.js';

/**
 * Converts a session Event to an A2A Message.
 *
 * @param event - The ADK event to convert.
 * @param appName - The name of the ADK application.
 * @param userId - The ID of the current user.
 * @param sessionId - The ID of the current session.
 * @returns An A2A message with the event's parts and metadata.
 */
export function toA2AMessage(
  event: AdkEvent,
  {
    appName,
    userId,
    sessionId,
  }: {appName: string; userId: string; sessionId: string},
): Message {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role:
      event.author === MessageRole.USER ? MessageRole.USER : MessageRole.AGENT,
    parts: toA2AParts(event.content?.parts || [], event.longRunningToolIds),
    metadata: getA2AEventMetadata(event, {appName, userId, sessionId}),
  };
}

/**
 * Converts an ADK event into the A2A artifact update event that carries its
 * content.
 *
 * The default implementation is `toA2AArtifactUpdateEvent`.
 */
export type AdkEventToA2AEventConverter = (
  adkEvent: AdkEvent,
  executorContext: ExecutorContext,
  partialArtifactIds: Record<string, string>,
  genAIPartConverter: GenAIPartToA2APartConverter,
) => TaskArtifactUpdateEvent | undefined;

/**
 * Converts an ADK event to an A2A artifact update event.
 *
 * Consecutive partial events from one author share an artifact id so the peer
 * can append the chunks to a single artifact. `partialArtifactIds` holds that
 * id between calls: the converter records it while the author streams, and
 * removes it once the author emits a complete event.
 *
 * @param adkEvent - The ADK event to convert.
 * @param executorContext - The context of the running A2A request.
 * @param partialArtifactIds - The artifact id currently streaming, per author.
 *   Mutated by this function.
 * @param genAIPartConverter - Converts a single part. Defaults to
 *   `toA2APart`.
 * @returns The artifact update event, or `undefined` if the ADK event has no
 *   convertible content.
 */
export function toA2AArtifactUpdateEvent(
  adkEvent: AdkEvent,
  executorContext: ExecutorContext,
  partialArtifactIds: Record<string, string>,
  genAIPartConverter: GenAIPartToA2APartConverter = toA2APart,
): TaskArtifactUpdateEvent | undefined {
  const a2aParts = toA2AParts(
    adkEvent.content?.parts,
    adkEvent.longRunningToolIds,
    genAIPartConverter,
  );
  if (a2aParts.length === 0) {
    return undefined;
  }

  const artifactId = partialArtifactIds[adkEvent.author!] || randomUUID();

  const a2aEvent = createTaskArtifactUpdateEvent({
    taskId: executorContext.requestContext.taskId,
    contextId: executorContext.requestContext.contextId,
    artifactId,
    parts: a2aParts,
    metadata: getA2AEventMetadata(adkEvent, executorContext),
    append: adkEvent.partial,
    lastChunk: !adkEvent.partial,
  });

  if (adkEvent.partial) {
    partialArtifactIds[adkEvent.author!] = artifactId;
  } else {
    delete partialArtifactIds[adkEvent.author!];
  }

  return a2aEvent;
}

/**
 * Converts one inbound A2A event into an ADK event.
 *
 * @remarks
 * `partConverter` is the part converter the caller configured, so an override
 * can hand it to the built-in converter it delegates to. Returning `undefined`
 * emits no event.
 */
export type A2AToAdkEventConverter<T> = (
  event: T,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
) => AdkEvent | undefined;

/** Converts an A2A Message. Defaults to {@link messageToAdkEvent}. */
export type A2AMessageToEventConverter = A2AToAdkEventConverter<Message>;

/** Converts an A2A Task. Defaults to {@link taskToAdkEvent}. */
export type A2ATaskToEventConverter = A2AToAdkEventConverter<Task>;

/**
 * Converts an A2A task status update. Defaults to
 * {@link statusUpdateToAdkEvent}.
 */
export type A2AStatusUpdateToEventConverter =
  A2AToAdkEventConverter<TaskStatusUpdateEvent>;

/**
 * Converts an A2A task artifact update. Defaults to
 * {@link artifactUpdateToAdkEvent}.
 */
export type A2AArtifactUpdateToEventConverter =
  A2AToAdkEventConverter<TaskArtifactUpdateEvent>;

/**
 * Converter overrides for the A2A to ADK event conversion.
 *
 * @remarks
 * Every field is optional. An omitted field falls back to the built-in
 * converter, so an empty bag reproduces the default conversion exactly. An
 * override owns the whole conversion for its A2A event kind: it may delegate
 * to the built-in converter and adjust the result, or return `undefined` to
 * emit no event at all.
 */
export interface A2AEventConverters {
  /** Converts an A2A Message. Defaults to {@link messageToAdkEvent}. */
  a2aMessageConverter?: A2AMessageToEventConverter;
  /** Converts an A2A Task. Defaults to {@link taskToAdkEvent}. */
  a2aTaskConverter?: A2ATaskToEventConverter;
  /**
   * Converts an A2A task status update. Defaults to
   * {@link statusUpdateToAdkEvent}.
   */
  a2aStatusUpdateConverter?: A2AStatusUpdateToEventConverter;
  /**
   * Converts an A2A task artifact update. Defaults to
   * {@link artifactUpdateToAdkEvent}.
   */
  a2aArtifactUpdateConverter?: A2AArtifactUpdateToEventConverter;
  /**
   * Converts an individual A2A part. Handed to whichever converter above
   * runs, including the built-in ones. Defaults to `toGenAIPart`.
   */
  a2aPartConverter?: A2APartToGenAIPartConverter;
}

/**
 * Converts an A2A Event to an ADK Session Event.
 *
 * @param event - The A2A event to convert (message, task, artifact update, or
 *   status update).
 * @param invocationId - The ADK invocation ID to attach to the resulting event.
 * @param agentName - The name of the agent to use as the event author.
 * @param branch - The local invocation's branch to attach to the resulting
 *   event. Must come from the caller's own `InvocationContext`, never from
 *   the A2A peer: see the comment on `createAdkEventFromMetadata` for why.
 * @param converters - Converter overrides. Defaults to the built-in
 *   converters.
 * @returns The converted ADK event, or `undefined` if the A2A event type
 *   produces no content.
 */
export function toAdkEvent(
  event: A2AEvent,
  invocationId: string,
  agentName: string,
  branch?: string,
  converters: A2AEventConverters = {},
): AdkEvent | undefined {
  const rest = [
    invocationId,
    agentName,
    branch,
    converters.a2aPartConverter,
  ] as const;

  if (isMessage(event)) {
    return (converters.a2aMessageConverter ?? messageToAdkEvent)(
      event,
      ...rest,
    );
  }

  if (isTask(event)) {
    return (converters.a2aTaskConverter ?? taskToAdkEvent)(event, ...rest);
  }

  if (isTaskArtifactUpdateEvent(event)) {
    return (converters.a2aArtifactUpdateConverter ?? artifactUpdateToAdkEvent)(
      event,
      ...rest,
    );
  }

  if (isTaskStatusUpdateEvent(event)) {
    return (converters.a2aStatusUpdateConverter ?? statusUpdateToAdkEvent)(
      event,
      ...rest,
    );
  }

  return undefined;
}

/**
 * Converts an A2A task status update to an ADK event.
 *
 * @param a2aEvent - The status update to convert.
 * @param invocationId - The ADK invocation ID to attach to the resulting event.
 * @param agentName - The name of the agent to use as the event author.
 * @param branch - The local invocation's branch to attach to the resulting
 *   event.
 * @param partConverter - Converts a single part. Defaults to `toGenAIPart`.
 * @returns The converted ADK event, or `undefined` if the update carries no
 *   content.
 */
export function statusUpdateToAdkEvent(
  a2aEvent: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
): AdkEvent | undefined {
  return a2aEvent.final
    ? finalTaskStatusUpdateToAdkEvent(
        a2aEvent,
        invocationId,
        agentName,
        branch,
        partConverter,
      )
    : taskStatusUpdateToAdkEvent(
        a2aEvent,
        invocationId,
        agentName,
        branch,
        partConverter,
      );
}

/**
 * Converts an A2A Message to an ADK event.
 *
 * @param msg - The message to convert.
 * @param invocationId - The ADK invocation ID to attach to the resulting event.
 * @param agentName - The name of the agent to use as the event author.
 * @param branch - The local invocation's branch to attach to the resulting
 *   event.
 * @param partConverter - Converts a single part. Defaults to `toGenAIPart`.
 * @returns The converted ADK event.
 */
export function messageToAdkEvent(
  msg: Message,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
): AdkEvent {
  const parts = toGenAIParts(msg.parts, partConverter);
  const content =
    parts.length === 0
      ? undefined
      : msg.role === MessageRole.USER
        ? createUserContent(parts)
        : createModelContent(parts);

  return {
    ...createAdkEventFromMetadata(msg),
    invocationId,
    author: msg.role === MessageRole.USER ? MessageRole.USER : agentName,
    branch,
    content,
    turnComplete: true,
    partial: false,
  };
}

/**
 * Converts an A2A task artifact update to an ADK event.
 *
 * @param a2aEvent - The artifact update to convert.
 * @param invocationId - The ADK invocation ID to attach to the resulting event.
 * @param agentName - The name of the agent to use as the event author.
 * @param branch - The local invocation's branch to attach to the resulting
 *   event.
 * @param partConverter - Converts a single part. Defaults to `toGenAIPart`.
 * @returns The converted ADK event, or `undefined` if the artifact carries no
 *   parts.
 */
export function artifactUpdateToAdkEvent(
  a2aEvent: TaskArtifactUpdateEvent,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
): AdkEvent | undefined {
  const partsToConvert = a2aEvent.artifact?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const partial =
    !!getEventMetadata(a2aEvent)[A2AMetadataKeys.PARTIAL] ||
    a2aEvent.append ||
    !a2aEvent.lastChunk;

  return {
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    branch,
    content: createModelContent(toGenAIParts(partsToConvert, partConverter)),
    longRunningToolIds: getLongRunningToolIDs(partsToConvert, partConverter),
    partial,
  };
}

function finalTaskStatusUpdateToAdkEvent(
  a2aEvent: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
): AdkEvent | undefined {
  const partsToConvert = a2aEvent.status.message?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const parts = toGenAIParts(partsToConvert, partConverter);
  const isFailedTask = isFailedTaskStatusUpdateEvent(a2aEvent);
  const hasContent = !isFailedTask && parts.length > 0;

  return {
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    branch,
    errorMessage: isFailedTask
      ? getFailedTaskStatusUpdateEventError(a2aEvent)
      : undefined,
    content: hasContent ? createModelContent(parts) : undefined,
    longRunningToolIds: getLongRunningToolIDs(partsToConvert, partConverter),
    turnComplete: true,
  };
}

function taskStatusUpdateToAdkEvent(
  a2aEvent: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
): AdkEvent | undefined {
  const msg = a2aEvent.status.message;
  if (!msg) {
    return undefined;
  }

  const parts = toGenAIParts(msg.parts, partConverter);
  if (parts.length === 0) {
    return undefined;
  }

  return {
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    branch,
    content: createModelContent(parts),
    turnComplete: false,
    partial: true,
  };
}

/**
 * Converts an A2A Task to an ADK event.
 *
 * @param a2aTask - The task to convert.
 * @param invocationId - The ADK invocation ID to attach to the resulting event.
 * @param agentName - The name of the agent to use as the event author.
 * @param branch - The local invocation's branch to attach to the resulting
 *   event.
 * @param partConverter - Converts a single part. Defaults to `toGenAIPart`.
 * @returns The converted ADK event, or `undefined` if the task carries no
 *   content and did not fail.
 */
export function taskToAdkEvent(
  a2aTask: Task,
  invocationId: string,
  agentName: string,
  branch?: string,
  partConverter?: A2APartToGenAIPartConverter,
): AdkEvent | undefined {
  const parts: GenAIPart[] = [];
  const longRunningToolIds: string[] = [];

  if (a2aTask.artifacts) {
    for (const artifact of a2aTask.artifacts) {
      if (artifact.parts?.length > 0) {
        const artifactParts = toGenAIParts(artifact.parts, partConverter);
        parts.push(...artifactParts);
        longRunningToolIds.push(
          ...getLongRunningToolIDs(artifact.parts, partConverter),
        );
      }
    }
  }

  if (a2aTask.status?.message) {
    const a2aParts = a2aTask.status.message.parts;
    const genAIParts = toGenAIParts(a2aParts, partConverter);

    parts.push(...genAIParts);
    longRunningToolIds.push(...getLongRunningToolIDs(a2aParts, partConverter));
  }

  const isTerminal =
    isTerminalTaskStatusUpdateEvent(a2aTask) ||
    isInputRequiredTaskStatusUpdateEvent(a2aTask);
  const isFailed = isFailedTaskStatusUpdateEvent(a2aTask);

  if (parts.length === 0 && !isFailed) {
    return undefined;
  }

  return {
    ...createAdkEventFromMetadata(a2aTask),
    invocationId,
    author: agentName,
    branch,
    content: isFailed ? undefined : createModelContent(parts),
    errorMessage: isFailed
      ? getFailedTaskStatusUpdateEventError(a2aTask)
      : undefined,
    longRunningToolIds,
    turnComplete: isTerminal,
  };
}

// EventActions fields a remote A2A peer may set on the event we emit
// for it. Every other field is dropped: see the comment at the call
// site in createAdkEventFromMetadata for why.
const PEER_SETTABLE_ACTION_FIELDS: ReadonlySet<string> = new Set(['escalate']);

function createAdkEventFromMetadata(a2aEvent: A2AEvent): AdkEvent {
  const metadata = a2aEvent.metadata || {};

  return createEvent({
    // `branch` is intentionally NOT restored from peer metadata here (unlike
    // the other fields below): it is the mechanism getContents() (see
    // content_processor_utils.ts) uses to keep sibling sub-agent branches'
    // conversation contexts isolated from each other. A remote A2A peer that
    // controls its own outgoing metadata could otherwise forge `adk_branch`
    // (set it to a shared ancestor branch, or omit it) to leak its content
    // into an unrelated sibling agent's LLM context. Every caller of the
    // `*ToAdkEvent` functions in this file force-sets `branch` from its own
    // local `InvocationContext` instead, the same way `author` is handled.
    author: metadata[A2AMetadataKeys.AUTHOR] as string,
    partial: metadata[A2AMetadataKeys.PARTIAL] as boolean,
    errorCode: metadata[A2AMetadataKeys.ERROR_CODE] as string,
    errorMessage: metadata[A2AMetadataKeys.ERROR_MESSAGE] as string,
    citationMetadata: metadata[
      A2AMetadataKeys.CITATION_METADATA
    ] as CitationMetadata,
    groundingMetadata: metadata[
      A2AMetadataKeys.GROUNDING_METADATA
    ] as GroundingMetadata,
    usageMetadata: metadata[A2AMetadataKeys.USAGE_METADATA] as UsageMetadata,
    customMetadata: metadata[A2AMetadataKeys.CUSTOM_METADATA] as Record<
      string,
      unknown
    >,
    // Only fields in PEER_SETTABLE_ACTION_FIELDS may be restored from
    // metadata a remote A2A peer controls. Every other action field either
    // mutates the caller's own session or drives the caller's own control
    // flow (e.g. `transferToAgent`, see llm_agent.ts), so it must never be
    // rebuilt from peer-supplied data. Filtering through an allowlist here
    // (rather than just omitting the unsafe field) means a future action
    // field is unsafe-by-default: adding it to `candidateActions` alone
    // does nothing until it's also added to the allowlist.
    actions: createEventActions(
      Object.fromEntries(
        Object.entries({
          escalate: !!metadata[A2AMetadataKeys.ESCALATE],
        }).filter(([key]) => PEER_SETTABLE_ACTION_FIELDS.has(key)),
      ),
    ),
  });
}

function getLongRunningToolIDs(
  parts: A2APart[],
  partConverter: A2APartToGenAIPartConverter = toGenAIPart,
): string[] {
  const ids: string[] = [];

  for (const a2aPart of parts) {
    if (a2aPart.metadata && a2aPart.metadata[A2AMetadataKeys.IS_LONG_RUNNING]) {
      const genAIPart = partConverter(a2aPart);
      if (genAIPart.functionCall && genAIPart.functionCall.id) {
        ids.push(genAIPart.functionCall.id);
      }
    }
  }

  return ids;
}
