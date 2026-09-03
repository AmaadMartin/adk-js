/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent} from '../events/event.js';
import {asRecord} from '../utils/error_utils.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';

/**
 * A2A task states that carry work in progress rather than the answer. An event
 * stamped with one of them must not become the node's output.
 */
const NON_FINAL_TASK_STATES: ReadonlySet<string> = new Set([
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'unknown',
]);

/**
 * Sets `event.output` from the event's non-thought text, when it is eligible.
 *
 * A node produces at most one output, so the caller stops after the first
 * event this returns `true` for. An event is skipped when it is partial, when
 * its output is already set, when `agentName` did not author it, when it
 * carries no plain text, or when the peer's task is still in progress.
 * Streaming converters do not always mark `working` text as a thought, so the
 * task state is checked as well.
 *
 * The author, not `nodeInfo.path`: the node runner stamps the path after the
 * node yields, so it is not set yet here.
 */
export function promoteResponseToOutput(
  event: AdkEvent,
  agentName: string,
): boolean {
  if (event.partial || event.output !== undefined) {
    return false;
  }
  if (event.author !== agentName) {
    return false;
  }
  if (isNonFinalTaskResponse(event)) {
    return false;
  }
  const text = (event.content?.parts ?? [])
    .filter(
      (part) =>
        part.text &&
        !part.thought &&
        !part.functionCall &&
        !part.functionResponse,
    )
    .map((part) => part.text)
    .join('');
  if (!text) {
    return false;
  }
  event.output = text;
  event.nodeInfo = {...event.nodeInfo, messageAsOutput: true};
  return true;
}

/** Whether the A2A response metadata reports a task still in progress. */
function isNonFinalTaskResponse(event: AdkEvent): boolean {
  const status = asRecord(event.customMetadata?.[AdkMetadataKeys.RESPONSE])?.[
    'status'
  ];
  const state = asRecord(status)?.['state'];
  return typeof state === 'string' && NON_FINAL_TASK_STATES.has(state);
}
