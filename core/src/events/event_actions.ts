/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {isEmpty} from 'lodash-es';

import {AuthConfig} from '../auth/auth_tool.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {carryDeltaStamps} from '../sessions/state_write_order.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';

/**
 * The compaction of a contiguous range of events. Mirrors Python
 * `EventCompaction`.
 *
 * Nothing in this SDK reads the timestamps, and no conversion happens on
 * either side, so they carry whatever unit the writer used. Python's
 * `EventCompaction` documents seconds; {@link Event.timestamp} here is in
 * milliseconds. Read them in the unit the writer of the event used.
 */
export interface EventCompaction {
  /** The start timestamp of the compacted events. */
  startTimestamp: number;

  /** The end timestamp of the compacted events. */
  endTimestamp: number;

  /** The summary that stands in for the compacted range. */
  compactedContent: Content;
}

/**
 * Represents the actions attached to an event.
 */
export interface EventActions {
  /**
   * If true, it won't call model to summarize function response.
   * Only used for function_response event.
   */
  skipSummarization?: boolean;

  /**
   * Indicates that the event is updating the state with the given delta.
   */
  stateDelta: {[key: string]: unknown};

  /**
   * Indicates that the event is updating an artifact. key is the filename,
   * value is the version.
   */
  artifactDelta: {[key: string]: number};

  /**
   * If set, the event transfers to the specified agent.
   */
  transferToAgent?: string;

  /**
   * The agent is escalating to a higher level agent.
   */
  escalate?: boolean;

  /**
   * Authentication configurations requested by tool responses.
   *
   * This field will only be set by a tool response event indicating tool
   * request auth credential.
   * - Keys: The function call id. Since one function response event could
   * contain multiple function responses that correspond to multiple function
   * calls. Each function call could request different auth configs. This id is
   * used to identify the function call.
   * - Values: The requested auth config.
   */
  requestedAuthConfigs: {[key: string]: AuthConfig};

  /**
   * A dict of tool confirmation requested by this event, keyed by the function
   * call id.
   */
  requestedToolConfirmations: {[key: string]: ToolConfirmation};

  /**
   * The range of events this event compacts, and the summary that stands in
   * for them. Mirrors Python `EventActions.compaction`.
   *
   * This SDK's own compaction pipeline uses `CompactedEvent` instead, and
   * nothing here reads this field. It is an opaque passthrough, so an event
   * that carries a compaction survives a round trip through adk-js unchanged.
   */
  compaction?: EventCompaction;

  /**
   * Workflow: a serialized node/agent state snapshot used for resumable
   * checkpointing. Mirrors Python `EventActions.agent_state`.
   */
  agentState?: Record<string, unknown>;

  /**
   * Workflow: marks that the emitting agent/workflow has reached the end of its
   * execution for this invocation. Mirrors Python `EventActions.end_of_agent`.
   */
  endOfAgent?: boolean;
}

/**
 * The keys {@link createEventActions} accepts, mirroring the reference model's
 * `extra='forbid'`.
 *
 * Keyed by `keyof EventActions` on purpose: a field added to the interface
 * fails to compile until it is listed here. A plain string array would instead
 * make the new field start being rejected at runtime, which no check catches.
 */
const EVENT_ACTIONS_KEYS: Record<keyof EventActions, true> = {
  skipSummarization: true,
  stateDelta: true,
  artifactDelta: true,
  transferToAgent: true,
  escalate: true,
  requestedAuthConfigs: true,
  requestedToolConfirmations: true,
  compaction: true,
  agentState: true,
  endOfAgent: true,
};

/**
 * Creates an {@link EventActions} object with default empty-dict values for
 * all dictionary fields.
 *
 * @param state - Optional partial {@link EventActions} whose properties
 *   override the defaults. Dictionary fields (`stateDelta`, `artifactDelta`,
 *   `requestedAuthConfigs`, `requestedToolConfirmations`) default to `{}`;
 *   scalar fields (`skipSummarization`, `transferToAgent`, `escalate`,
 *   `compaction`) default to `undefined`.
 * @returns A fully populated {@link EventActions} object.
 * @throws {InputValidationError} When `state` carries a key that is not an
 *   {@link EventActions} field.
 */
export function createEventActions(
  state: Partial<EventActions> = {},
): EventActions {
  validateActionKeys(state);
  return {
    stateDelta: {},
    artifactDelta: {},
    requestedAuthConfigs: {},
    requestedToolConfirmations: {},
    ...state,
  };
}

/**
 * Rejects a key that is not an {@link EventActions} field.
 *
 * TypeScript's excess-property check already rejects a stray key in an object
 * literal, so this fires on input the compiler never saw: a widened object, or
 * a call from plain JavaScript. Silently dropping such a key loses the action
 * it asked for.
 *
 * It guards what callers build in this process, and only that. An event
 * rehydrated from storage is cast by `transformToCamelCaseEvent`, so it never
 * reaches this check.
 *
 * `Object.hasOwn` rather than `in`, or every `Object.prototype` member
 * (`toString`, `constructor`) would pass as a declared field.
 *
 * @throws {InputValidationError} Naming every offending key.
 */
function validateActionKeys(state: Partial<EventActions>): void {
  const unknownKeys = Object.keys(state).filter(
    (key) => !Object.hasOwn(EVENT_ACTIONS_KEYS, key),
  );
  if (unknownKeys.length > 0) {
    throw new InputValidationError(
      `EventActions received unknown key(s): ${unknownKeys.join(', ')}. ` +
        'Fields are camelCase; see EventActions.',
    );
  }
}

/**
 * Returns whether the given {@link EventActions} still holds only its default
 * values, i.e. the event carries no state, artifact, auth, confirmation,
 * transfer, escalation or summarization signal.
 *
 * An actions object is considered non-default when any dictionary field has at
 * least one entry, or when any scalar field has been explicitly set (including
 * being set to `false`).
 *
 * @param actions - The actions to inspect.
 * @returns `true` when every field is at its default value.
 */
export function isDefaultEventActions(actions: EventActions): boolean {
  return (
    isEmpty(actions.stateDelta) &&
    isEmpty(actions.artifactDelta) &&
    isEmpty(actions.requestedAuthConfigs) &&
    isEmpty(actions.requestedToolConfirmations) &&
    actions.skipSummarization === undefined &&
    actions.transferToAgent === undefined &&
    actions.escalate === undefined &&
    actions.compaction === undefined
  );
}

/**
 * Merges a list of {@link EventActions} objects into a single
 * {@link EventActions} object.
 *
 * Merge semantics:
 * 1. **Dictionary fields** (`stateDelta`, `artifactDelta`,
 *    `requestedAuthConfigs`, `requestedToolConfirmations`) — all entries from
 *    every source are combined via `Object.assign`. Later sources win on
 *    duplicate keys.
 * 2. **Scalar fields** (`skipSummarization`, `transferToAgent`, `escalate`,
 *    `compaction`) — last-writer-wins: the value from the last source that sets
 *    the field is kept.
 *
 * @param sources - Ordered list of partial {@link EventActions} to merge.
 *   Falsy entries are silently skipped.
 * @param target - Optional base {@link EventActions} to merge into. When
 *   provided it is used as the starting state before applying `sources`.
 * @returns A new {@link EventActions} containing the merged result.
 */
export function mergeEventActions(
  sources: Array<Partial<EventActions>>,
  target?: EventActions,
): EventActions {
  const result = createEventActions();

  if (target) {
    Object.assign(result, target);
  }

  for (const source of sources) {
    if (!source) continue;

    if (source.stateDelta) {
      Object.assign(result.stateDelta, source.stateDelta);
      // The merged map is a new object; carry the write order with the entries
      // so a late commit can still tell it has been superseded.
      carryDeltaStamps(source.stateDelta, result.stateDelta);
    }
    if (source.artifactDelta) {
      Object.assign(result.artifactDelta, source.artifactDelta);
    }
    if (source.requestedAuthConfigs) {
      Object.assign(result.requestedAuthConfigs, source.requestedAuthConfigs);
    }
    if (source.requestedToolConfirmations) {
      Object.assign(
        result.requestedToolConfirmations,
        source.requestedToolConfirmations,
      );
    }

    if (source.skipSummarization !== undefined) {
      result.skipSummarization = source.skipSummarization;
    }
    if (source.transferToAgent !== undefined) {
      result.transferToAgent = source.transferToAgent;
    }
    if (source.escalate !== undefined) {
      result.escalate = source.escalate;
    }
    if (source.compaction !== undefined) {
      result.compaction = source.compaction;
    }
  }
  return result;
}
