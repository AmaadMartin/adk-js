/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  isFinishTaskTerminalResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** An event carrying one function response. */
function responseEvent(name: string, response?: Record<string, unknown>) {
  return createEvent({
    author: 'agent',
    content: {
      role: 'user',
      parts: [{functionResponse: {id: 'fr-1', name, response}}],
    },
  });
}

describe('isFinishTaskTerminalResponse', () => {
  it('recognises a successful completion', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME, {
      result: FINISH_TASK_SUCCESS_RESULT,
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(true);
  });

  it('recognises a reported failure', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME, {
      result: FINISH_TASK_ERROR_RESULT,
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(true);
  });

  it('rejects a validation error, so the agent can retry', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME, {
      error: 'missing required parameters: summary',
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });

  it('rejects a response with no payload', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME);

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });

  it('rejects a response from another tool', () => {
    const event = responseEvent('other_tool', {
      result: FINISH_TASK_SUCCESS_RESULT,
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });

  it('rejects an event carrying no function response', () => {
    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'done'}]},
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });
});
