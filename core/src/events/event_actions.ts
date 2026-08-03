/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig} from '../auth/auth_tool.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';

import {UiWidget} from './ui_widget.js';

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
   * UI widgets to be rendered by the UI host for this event.
   */
  renderUiWidgets?: UiWidget[];
}

/**
 * Creates an {@link EventActions} object with default empty-dict values for
 * all dictionary fields.
 *
 * @param state - Optional partial {@link EventActions} whose properties
 *   override the defaults. Dictionary fields (`stateDelta`, `artifactDelta`,
 *   `requestedAuthConfigs`, `requestedToolConfirmations`) default to `{}`;
 *   scalar fields (`skipSummarization`, `transferToAgent`, `escalate`) and list
 *   fields (`renderUiWidgets`) default to `undefined`.
 * @returns A fully populated {@link EventActions} object.
 */
export function createEventActions(
  state: Partial<EventActions> = {},
): EventActions {
  return {
    stateDelta: {},
    artifactDelta: {},
    requestedAuthConfigs: {},
    requestedToolConfirmations: {},
    ...state,
  };
}

const RENDER_UI_WIDGETS_SNAKE_CASE_KEY = 'render_ui_widgets';

/**
 * Reads UI widgets off a partial {@link EventActions}, accepting both the
 * camelCase field and the snake_case spelling ADK Python writes on the wire.
 * An empty camelCase list falls through to the snake_case key, matching
 * `merge_parallel_function_response_events` in adk-python
 * (`src/google/adk/flows/llm_flows/functions.py`).
 */
function readRenderUiWidgets(
  source: Partial<EventActions>,
): UiWidget[] | undefined {
  if (source.renderUiWidgets?.length) {
    return source.renderUiWidgets;
  }
  const snakeCased = (source as Record<string, unknown>)[
    RENDER_UI_WIDGETS_SNAKE_CASE_KEY
  ];
  return Array.isArray(snakeCased) ? (snakeCased as UiWidget[]) : undefined;
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
 * 3. **List fields** (`renderUiWidgets`) — concatenated in source order. Both
 *    the camelCase key and the snake_case `render_ui_widgets` spelling are
 *    read on input; the result always uses the camelCase key.
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

    const uiWidgets = readRenderUiWidgets(source);
    if (uiWidgets?.length) {
      result.renderUiWidgets = [
        ...(result.renderUiWidgets ?? []),
        ...uiWidgets,
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
  }
  return result;
}
