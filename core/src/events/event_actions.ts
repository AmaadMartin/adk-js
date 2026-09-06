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

import {UiWidget} from './ui_widget.js';

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

  /**
   * UI widgets the host should render alongside this event, appended by
   * `Context.renderUiWidget`. Mirrors Python
   * `EventActions.render_ui_widgets`, which defaults to `None`, so the field
   * stays unset until a widget is pushed.
   */
  renderUiWidgets?: UiWidget[];

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
   * The structured output the model submitted through the
   * `set_model_response` tool, already checked against the agent's output
   * schema. Its shape is the schema's, so it stays untyped here, as in Python
   * `EventActions.set_model_response`.
   */
  setModelResponse?: unknown;

  /**
   * The invocation id to rewind to. This is only set for a rewind event.
   *
   * `applyRewinds` reads it to drop the rewound invocations, so the annulled
   * turns never reach the model.
   */
  rewindBeforeInvocationId?: string;
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
  renderUiWidgets: true,
  transferReason: true,
  route: true,
  setModelResponse: true,
  rewindBeforeInvocationId: true,
};

/**
 * Creates an {@link EventActions} object with default empty-dict values for
 * all dictionary fields.
 *
 * @param state - Optional partial {@link EventActions} whose properties
 *   override the defaults. Dictionary fields (`stateDelta`, `artifactDelta`,
 *   `requestedAuthConfigs`, `requestedToolConfirmations`) default to `{}`;
 *   scalar fields (`skipSummarization`, `transferToAgent`, `escalate`,
 *   `rewindBeforeInvocationId`, `compaction`) default to `undefined`.
 * @returns A fully populated {@link EventActions} object.
 * @throws {InputValidationError} When `state` carries a key that is not an
 *   {@link EventActions} field.
 */
export function createEventActions(
  state: Partial<EventActions> = {},
): EventActions {
  validateActionKeys(state);
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
function validateRequestedAuthConfigs(
  configs: {[key: string]: AuthConfig} | undefined,
): void {
  for (const [key, config] of Object.entries(configs ?? {})) {
    if (!isAuthConfig(config)) {
      throw new InputValidationError(
        `requestedAuthConfigs['${key}'] is not a valid AuthConfig: expected an object with 'authScheme' and 'credentialKey'.`,
      );
    }
  }
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
 * least one entry, when any scalar field has been explicitly set (including
 * being set to `false`), or when a UI widget is attached.
 *
 * A pushed UI widget counts as a signal too: a tool that renders a widget and
 * nothing else still has something for the host to draw, so its event must
 * survive the callers that drop default-only actions.
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
    isEmpty(actions.renderUiWidgets) &&
    actions.skipSummarization === undefined &&
    actions.transferToAgent === undefined &&
    actions.escalate === undefined &&
    actions.transferReason === undefined &&
    actions.route === undefined &&
    actions.setModelResponse === undefined &&
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
 *    `transferReason`, `route`, `setModelResponse`,
 *    `rewindBeforeInvocationId`, `compaction`, `agentState`, `endOfAgent`) —
 *    last-writer-wins: the value from the last source that sets the field is
 *    kept.
 * 3. **List fields** (`renderUiWidgets`) — the widgets of every source are
 *    concatenated in source order. A source that sets nothing contributes
 *    nothing, so the result stays `undefined` when no source sets it.
 *    Parallel function responses each render their own widget, and
 *    last-writer-wins would drop every widget but the last.
 *
 * Every field of {@link EventActions} is covered. A field added to that type
 * must be added here too, or a merge silently drops it.
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

    if (source.renderUiWidgets) {
      result.renderUiWidgets = [
        ...(result.renderUiWidgets ?? []),
        ...source.renderUiWidgets,
      ];
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
    if (source.rewindBeforeInvocationId !== undefined) {
      result.rewindBeforeInvocationId = source.rewindBeforeInvocationId;
    }
    if (source.compaction !== undefined) {
      result.compaction = source.compaction;
    }
    if (source.agentState !== undefined) {
      result.agentState = source.agentState;
    }
    if (source.endOfAgent !== undefined) {
      result.endOfAgent = source.endOfAgent;
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
 * @returns A shallow copy holding the sanitized fields. Never throws.
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
  state: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> {
  let replaced = false;
  const sanitized: Record<string, unknown> = {};

  // `stateDelta` is a required field, but a caller can still hand us an
  // actions object that leaves it unset. Treat that as the empty delta that
  // `createEventActions` defaults to, so the event still persists.
  for (const [key, value] of Object.entries(state ?? {})) {
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
