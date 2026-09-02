/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {isEmpty} from 'lodash-es';

import {AuthConfig, isAuthConfig} from '../auth/auth_tool.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {carryDeltaStamps} from '../sessions/state_write_order.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {toJsonSerializable} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';
// `event.ts` imports this module at runtime, so `Route` is imported as a type
// to keep the dependency one-way.
import type {Route} from './event.js';

/**
 * The compaction of a contiguous range of events. Mirrors Python
 * `EventCompaction`.
 */
export interface EventCompaction {
  /**
   * The start timestamp of the compacted events, in the same unit as
   * {@link Event.timestamp} (milliseconds since the epoch). Python records
   * seconds here; neither side converts.
   */
  startTimestamp: number;

  /** The end timestamp of the compacted events, in the same unit. */
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
   * Workflow: a serialized node/agent state snapshot used for resumable
   * checkpointing. Mirrors Python `EventActions.agent_state`.
   */
  agentState?: Record<string, unknown>;

  /**
   * Workflow: marks that the emitting agent/workflow has reached the end of its
   * execution for this invocation. Mirrors Python `EventActions.end_of_agent`.
   */
  endOfAgent?: boolean;

  /**
   * The reason for transferring to the target agent. Mirrors Python
   * `EventActions.transfer_reason`.
   */
  transferReason?: string;

  /**
   * The route key(s) emitted by a routing node, used by the graph to select the
   * matching outgoing edge(s). Mirrors Python `EventActions.route`.
   *
   * This is the copy that crosses the wire. The workflow engine reads
   * {@link Event.route}, which `transformToCamelCaseEvent` fills from this
   * field when it rehydrates an event.
   */
  route?: Route;

  /**
   * The structured output a model produced for this event. Mirrors Python
   * `EventActions.set_model_response`, which is untyped there too.
   */
  setModelResponse?: unknown;

  /**
   * The range of events this event compacts, and the summary that stands in
   * for them. Mirrors Python `EventActions.compaction`.
   *
   * This SDK's own compaction pipeline uses `CompactedEvent` instead. The
   * field is here so a compaction written by a Python runner survives the
   * wire.
   */
  compaction?: EventCompaction;

  /**
   * The invocation id to rewind to. Only set on a rewind event. Mirrors Python
   * `EventActions.rewind_before_invocation_id`.
   *
   * This SDK has no rewind machinery yet, so nothing here reads the field. It
   * is carried so a rewind marker written by a Python runner survives the
   * wire.
   */
  rewindBeforeInvocationId?: string;
}

/**
 * Creates an {@link EventActions} object with default empty-dict values for
 * all dictionary fields.
 *
 * @param state - Optional partial {@link EventActions} whose properties
 *   override the defaults. Dictionary fields (`stateDelta`, `artifactDelta`,
 *   `requestedAuthConfigs`, `requestedToolConfirmations`) default to `{}`;
 *   scalar fields (`skipSummarization`, `transferToAgent`, `escalate`) default
 *   to `undefined`.
 * @returns A fully populated {@link EventActions} object.
 */
export function createEventActions(
  state: Partial<EventActions> = {},
): EventActions {
  const actions = {
    stateDelta: {},
    artifactDelta: {},
    requestedAuthConfigs: {},
    requestedToolConfirmations: {},
    ...state,
  };
  validateRequestedAuthConfigs(actions.requestedAuthConfigs);
  return actions;
}

/**
 * Rejects a `requestedAuthConfigs` entry that is not an {@link AuthConfig}.
 *
 * Mirrors the reference's `_parse_auth_configs` validator, which runs
 * `AuthConfig.model_validate` on every entry. An event rehydrated from storage
 * carries plain objects here, and one that has lost `authScheme` or
 * `credentialKey` fails much later, inside the auth flow.
 *
 * @throws {InputValidationError} When an entry is not an {@link AuthConfig}.
 */
function validateRequestedAuthConfigs(configs: {
  [key: string]: AuthConfig;
}): void {
  for (const [key, config] of Object.entries(configs)) {
    if (!isAuthConfig(config)) {
      throw new InputValidationError(
        `requestedAuthConfigs['${key}'] is not a valid AuthConfig: expected an object with 'authScheme' and 'credentialKey'.`,
      );
    }
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
    actions.transferReason === undefined &&
    actions.route === undefined &&
    actions.setModelResponse === undefined &&
    actions.compaction === undefined &&
    actions.rewindBeforeInvocationId === undefined
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
 * 2. **Scalar fields** (`skipSummarization`, `transferToAgent`, `escalate`) —
 *    last-writer-wins: the value from the last source that sets the field is
 *    kept.
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
    if (source.transferReason !== undefined) {
      result.transferReason = source.transferReason;
    }
    if (source.route !== undefined) {
      result.route = source.route;
    }
    if (source.setModelResponse !== undefined) {
      result.setModelResponse = source.setModelResponse;
    }
    if (source.compaction !== undefined) {
      result.compaction = source.compaction;
    }
    if (source.rewindBeforeInvocationId !== undefined) {
      result.rewindBeforeInvocationId = source.rewindBeforeInvocationId;
    }
  }
  return result;
}

/**
 * Returns a copy of the actions whose `stateDelta` and `agentState` are safe
 * to hand to `JSON.stringify`.
 *
 * A tool can write anything into session state, including a callback or a
 * bigint. Persisting such an event used to throw or drop the offending key
 * along with its siblings. Mirrors the reference's `_serialize_state_delta`
 * and `_serialize_agent_state` wrap serializers: the value is sanitized, one
 * warning per field is logged, and the event still persists.
 *
 * @param actions The actions about to be persisted.
 * @returns A shallow copy holding the sanitized fields. No value held in
 *   `stateDelta` or `agentState` can make it throw.
 */
export function serializeEventActions(actions: EventActions): EventActions {
  return {
    ...actions,
    stateDelta: sanitizeState(actions.stateDelta, 'stateDelta'),
    agentState:
      actions.agentState === undefined
        ? undefined
        : sanitizeState(actions.agentState, 'agentState'),
  };
}

function sanitizeState(
  state: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  let replaced = false;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(state)) {
    sanitized[key] = toJsonSerializable(value, () => {
      replaced = true;
    });
  }

  if (replaced) {
    logger.warn(
      `Failed to serialize \`${field}\`; some values are not JSON-serializable ` +
        `(e.g. functions) and will be replaced with a string representation ` +
        `in the persisted event.`,
    );
  }
  return sanitized;
}
