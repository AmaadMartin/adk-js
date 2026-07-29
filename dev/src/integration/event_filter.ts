/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, EventActions} from '@google/adk';
import {Part} from '@google/genai';
import {
  FilteredEvent,
  FilteredEventActions,
  FilteredPart,
} from './test_types.js';

/**
 * Rebuilds an event without the fields conformance must not compare.
 *
 * Dropped are the fields that legitimately differ between two runs of the same
 * test, plus the empty and unset ones, so that two events describing the same
 * agent behaviour compare deeply equal. The source event's own fields are left
 * in place; nested objects are shared with it and may be pruned in place.
 */
export function normalizeEvent(event: Event): FilteredEvent {
  const {
    id: _id,
    invocationId: _invocationId,
    timestamp: _timestamp,
    longRunningToolIds: _longRunningToolIds,
    actions,
    content,
    ...comparedFields
  } = event;

  const filtered = {
    ...comparedFields,
    actions: comparableActions(actions),
    content: content && {...content, parts: content.parts?.map(comparablePart)},
  };
  removeEmptyAndUndefinedFields(filtered);
  return filtered;
}

function comparableActions(actions: EventActions): FilteredEventActions {
  // Recorded sessions are cast from YAML, so `actions` and `stateDelta` can be
  // absent at runtime even though the types require them. Spreading before
  // destructuring tolerates that.
  const {
    requestedAuthConfigs: _requestedAuthConfigs,
    requestedToolConfirmations: _requestedToolConfirmations,
    stateDelta,
    ...comparedActions
  } = {...actions};
  // _adk_recordings_config and _adk_replay_config are written by the recording
  // and replay plugins: they describe how the test ran, not what the agent did.
  const {_adk_recordings_config, _adk_replay_config, ...comparedStateDelta} = {
    ...stateDelta,
  };

  return {...comparedActions, stateDelta: comparedStateDelta};
}

function comparablePart(part: Part): FilteredPart {
  const {
    thoughtSignature: _thoughtSignature,
    functionCall: _functionCall,
    functionResponse: _functionResponse,
    ...comparedPart
  } = part;

  return comparedPart;
}

function removeEmptyAndUndefinedFields(obj: Record<string, unknown>) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || obj[key] === null) {
      delete obj[key];
    } else if (Array.isArray(obj[key])) {
      for (let i = 0; i < obj[key].length; i++) {
        removeEmptyAndUndefinedFields(obj[key][i] as Record<string, unknown>);
      }

      // Remove fields that are just an empty array
      if (obj[key].length === 0) {
        delete obj[key];
      }
    } else if (typeof obj[key] === 'object') {
      removeEmptyAndUndefinedFields(obj[key] as Record<string, unknown>);

      // Remove fields that are just an empty object
      if (Object.keys(obj[key] as Record<string, unknown>).length === 0) {
        delete obj[key];
      }
    }
  }
}
