/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {A2AEvent, createTaskArtifactUpdateEvent} from './a2a_event.js';
import {ExecutorContext} from './executor_context.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
  toA2APart,
  toGenAIPart,
} from './part_converter_utils.js';

/**
 * Converts one ADK event into the A2A events that represent it, taking the
 * execution context.
 *
 * Mirrors the legacy `AdkEventToA2AEventsConverter` in
 * `google/adk/a2a/converters/event_converter.py`. adk-python passes an
 * `InvocationContext` where adk-js passes its `ExecutorContext`.
 */
export type AdkEventToA2AEventsConverter = (
  adkEvent: AdkEvent,
  executorContext: ExecutorContext,
  taskId: string,
  contextId: string,
  genAiPartConverter: GenAIPartToA2APartConverter,
) => A2AEvent[];

/**
 * Converts one ADK event into the A2A events that represent it, taking the
 * artifact map of the execution in progress.
 *
 * Mirrors `AdkEventToA2AEventsConverter` in
 * `google/adk/a2a/converters/from_adk_event.py`, aliased
 * `AdkEventToA2AEventsConverterImpl` in `a2a/executor/config.py`.
 *
 * `agentsArtifacts` maps an event author to the artifact id it streams into,
 * so the chunks of one response append to one artifact. The converter mutates
 * it, and it belongs to a single execution.
 */
export type AdkEventToA2AEventsConverterImpl = (
  adkEvent: AdkEvent,
  agentsArtifacts: Map<string, string> | undefined,
  taskId: string,
  contextId: string,
  genAiPartConverter: GenAIPartToA2APartConverter,
) => A2AEvent[];

/**
 * Converts one ADK event into a single artifact update carrying its parts.
 *
 * An event with no convertible parts produces no A2A event. A partial event
 * reuses the artifact id its author is already streaming into, and the final
 * chunk releases that id.
 *
 * The executor stamps ADK metadata onto every converted event, so this
 * converter sets none.
 *
 * @throws {Error} If `agentsArtifacts` is undefined. The signature accepts
 *   undefined to mirror adk-python's `Optional[Dict[str, str]]`, which raises
 *   `ValueError` on `None` the same way.
 */
export function toA2AArtifactUpdateEventsFromArtifactMap(
  adkEvent: AdkEvent,
  agentsArtifacts: Map<string, string> | undefined,
  taskId: string,
  contextId: string,
  genAiPartConverter: GenAIPartToA2APartConverter = toA2APart,
): A2AEvent[] {
  if (!agentsArtifacts) {
    throw new Error('A2A executor artifact map cannot be undefined');
  }

  const parts = (adkEvent.content?.parts ?? []).map((part) =>
    genAiPartConverter(part, adkEvent.longRunningToolIds ?? []),
  );
  if (parts.length === 0) {
    return [];
  }

  const author = adkEvent.author!;
  const artifactId = agentsArtifacts.get(author) || randomUUID();
  const a2aEvent = createTaskArtifactUpdateEvent({
    taskId,
    contextId,
    artifactId,
    parts,
    append: adkEvent.partial,
    lastChunk: !adkEvent.partial,
  });

  if (adkEvent.partial) {
    agentsArtifacts.set(author, artifactId);
  } else {
    agentsArtifacts.delete(author);
  }

  return [a2aEvent];
}

/**
 * The artifact map each execution streams into, keyed by its context.
 *
 * The legacy converter signature has no slot for the map, so the built-in
 * legacy converter hangs one off the execution it was called for. A `WeakMap`
 * releases it when the execution ends.
 */
const legacyArtifactIds = new WeakMap<ExecutorContext, Map<string, string>>();

/**
 * Converts one ADK event into a single artifact update, in the legacy shape.
 *
 * This is the `eventConverter` counterpart of
 * `toA2AArtifactUpdateEventsFromArtifactMap`, for an embedder who fills the
 * legacy slot and wants the built-in conversion under their own logic. It
 * produces the same events, keyed on the execution rather than on a map the
 * caller holds.
 */
export function toA2AArtifactUpdateEvents(
  adkEvent: AdkEvent,
  executorContext: ExecutorContext,
  taskId: string,
  contextId: string,
  genAiPartConverter: GenAIPartToA2APartConverter = toA2APart,
): A2AEvent[] {
  let agentsArtifacts = legacyArtifactIds.get(executorContext);
  if (!agentsArtifacts) {
    agentsArtifacts = new Map();
    legacyArtifactIds.set(executorContext, agentsArtifacts);
  }

  return toA2AArtifactUpdateEventsFromArtifactMap(
    adkEvent,
    agentsArtifacts,
    taskId,
    contextId,
    genAiPartConverter,
  );
}

/**
 * The converters an embedder can plug into the A2A executor.
 *
 * Every field is optional, and an unset field takes its declared default from
 * {@link A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS}.
 */
export interface A2aAgentExecutorConverterConfig {
  /** Converts one inbound A2A part. Defaults to `toGenAIPart`. */
  a2aPartConverter?: A2APartToGenAIPartConverter;

  /** Converts one outbound GenAI part. Defaults to `toA2APart`. */
  genAiPartConverter?: GenAIPartToA2APartConverter;

  /**
   * Converts one ADK event, taking the execution context.
   *
   * Unset by default. When it is set the executor calls it instead of
   * `adkEventConverter`.
   */
  eventConverter?: AdkEventToA2AEventsConverter;

  /**
   * Converts one ADK event, taking the artifact map of the execution in
   * progress. Defaults to `toA2AArtifactUpdateEventsFromArtifactMap`.
   */
  adkEventConverter?: AdkEventToA2AEventsConverterImpl;
}

/**
 * A converter config with every defaulted slot filled.
 */
export interface ResolvedA2aAgentExecutorConfig {
  a2aPartConverter: A2APartToGenAIPartConverter;
  genAiPartConverter: GenAIPartToA2APartConverter;
  eventConverter?: AdkEventToA2AEventsConverter;
  adkEventConverter: AdkEventToA2AEventsConverterImpl;
}

/**
 * Every default the A2A executor config declares, in one place.
 *
 * Mirrors the field defaults of `A2aAgentExecutorConfig` in
 * `google/adk/a2a/executor/config.py`.
 */
export const A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS: Readonly<ResolvedA2aAgentExecutorConfig> =
  Object.freeze({
    a2aPartConverter: toGenAIPart,
    genAiPartConverter: toA2APart,
    eventConverter: undefined,
    adkEventConverter: toA2AArtifactUpdateEventsFromArtifactMap,
  });

/** The config fields the resolver validates, in the order it reports them. */
const CONVERTER_FIELDS = [
  'a2aPartConverter',
  'genAiPartConverter',
  'eventConverter',
  'adkEventConverter',
] as const;

/**
 * Fills every unset converter slot from the declared defaults.
 *
 * adk-python validates the same config through pydantic, which rejects a
 * non-callable field when the model is constructed. This is that check.
 *
 * @param config - The converters the embedder supplied. Not mutated.
 * @throws {Error} If a field is present and is not a function. `undefined`
 *   selects the default; `null` is a supplied value of the wrong type and is
 *   rejected.
 */
export function resolveA2aAgentExecutorConfig(
  config: A2aAgentExecutorConverterConfig,
): ResolvedA2aAgentExecutorConfig {
  for (const field of CONVERTER_FIELDS) {
    const value = config[field];
    if (value !== undefined && typeof value !== 'function') {
      throw new Error(
        `A2A executor config field "${field}" must be a function, received ` +
          `${value === null ? 'null' : typeof value}`,
      );
    }
  }

  return {
    a2aPartConverter:
      config.a2aPartConverter ??
      A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS.a2aPartConverter,
    genAiPartConverter:
      config.genAiPartConverter ??
      A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS.genAiPartConverter,
    eventConverter:
      config.eventConverter ??
      A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS.eventConverter,
    adkEventConverter:
      config.adkEventConverter ??
      A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS.adkEventConverter,
  };
}
