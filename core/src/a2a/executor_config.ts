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
  toA2AParts,
  toGenAIPart,
} from './part_converter_utils.js';

/**
 * Converts one ADK event into the A2A events that represent it.
 *
 * Mirrors `AdkEventToA2AEventsConverter` in
 * `google/adk/a2a/converters/from_adk_event.py`, which
 * `a2a/executor/config.py` imports under the alias
 * `AdkEventToA2AEventsConverterImpl`.
 *
 * `agentsArtifacts` maps an event author to the artifact id it streams into,
 * so the chunks of one response append to one artifact. The converter mutates
 * it, and it belongs to a single execution.
 */
export type AdkEventToA2AEventsConverterImpl = (
  adkEvent: AdkEvent,
  agentsArtifacts: Map<string, string>,
  taskId: string,
  contextId: string,
  genAiPartConverter: GenAIPartToA2APartConverter,
) => A2AEvent[];

/**
 * Converts one ADK event into the A2A events that represent it, reading the
 * executor context rather than the artifact map.
 *
 * Mirrors `AdkEventToA2AEventsConverter` in
 * `google/adk/a2a/converters/event_converter.py`, which
 * `a2a/executor/config.py` declares as `event_converter` for its legacy
 * executor. `ctx.requestContext` carries the task id and the context id that
 * the Python signature passes separately.
 */
export type AdkEventToA2AEventsConverter = (
  adkEvent: AdkEvent,
  ctx: ExecutorContext,
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
 */
export function toA2AArtifactUpdateEventsFromArtifactMap(
  adkEvent: AdkEvent,
  agentsArtifacts: Map<string, string>,
  taskId: string,
  contextId: string,
  genAiPartConverter: GenAIPartToA2APartConverter = toA2APart,
): A2AEvent[] {
  const parts = toA2AParts(
    adkEvent.content?.parts,
    adkEvent.longRunningToolIds,
    genAiPartConverter,
  );
  if (parts.length === 0) {
    return [];
  }

  const author = adkEvent.author ?? '';
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
 * The converters an embedder can plug into the A2A executor.
 *
 * Every field is optional, and an unset field takes the default named on it.
 */
export interface A2aAgentExecutorConverterConfig {
  /** Converts one inbound A2A part. Defaults to `toGenAIPart`. */
  a2aPartConverter?: A2APartToGenAIPartConverter;

  /** Converts one outbound GenAI part. Defaults to `toA2APart`. */
  genAiPartConverter?: GenAIPartToA2APartConverter;

  /**
   * Converts one ADK event, reading the executor context. It has no default,
   * and the executor prefers it over {@link
   * A2aAgentExecutorConverterConfig.adkEventConverter} when both are set.
   */
  eventConverter?: AdkEventToA2AEventsConverter;

  /**
   * Converts one ADK event. Defaults to
   * `toA2AArtifactUpdateEventsFromArtifactMap`.
   */
  adkEventConverter?: AdkEventToA2AEventsConverterImpl;
}

/**
 * The validated converters the executor runs, with every default applied.
 *
 * The executor reads every converter from here, so this is the only place the
 * defaults are decided. `eventConverter` stays optional: it declares no
 * default, and the executor falls through to `adkEventConverter` without it.
 */
export interface ResolvedA2aAgentExecutorConfig {
  a2aPartConverter: A2APartToGenAIPartConverter;
  genAiPartConverter: GenAIPartToA2APartConverter;
  eventConverter?: AdkEventToA2AEventsConverter;
  adkEventConverter: AdkEventToA2AEventsConverterImpl;
}

/** The config fields the resolver validates, in the order it reports them. */
const CONVERTER_FIELDS = [
  'a2aPartConverter',
  'genAiPartConverter',
  'eventConverter',
  'adkEventConverter',
] as const;

/**
 * Validates every converter slot, and fills each unset defaulted one with the
 * default the config declares.
 *
 * adk-python declares the same defaults on a pydantic model
 * (`A2aAgentExecutorConfig` in `google/adk/a2a/executor/config.py`), which
 * also rejects a non-callable field when the model is constructed. This is
 * that check.
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
    a2aPartConverter: config.a2aPartConverter ?? toGenAIPart,
    genAiPartConverter: config.genAiPartConverter ?? toA2APart,
    eventConverter: config.eventConverter,
    adkEventConverter:
      config.adkEventConverter ?? toA2AArtifactUpdateEventsFromArtifactMap,
  };
}
