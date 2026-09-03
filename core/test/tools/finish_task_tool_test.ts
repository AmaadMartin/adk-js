/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  getOutputWrapperKey,
  isFinishTaskTerminalFr,
} from '../../src/tools/finish_task_tool.js';

function functionResponseEvent(
  name: string,
  response: Record<string, unknown>,
): Event {
  return createEvent({
    author: 'worker',
    content: {role: 'user', parts: [{functionResponse: {name, response}}]},
  });
}

describe('isFinishTaskTerminalFr', () => {
  it('accepts the success result', () => {
    const event = functionResponseEvent(FINISH_TASK_TOOL_NAME, {
      result: FINISH_TASK_SUCCESS_RESULT,
    });
    expect(isFinishTaskTerminalFr(event)).toBe(true);
  });

  it('accepts the error result', () => {
    const event = functionResponseEvent(FINISH_TASK_TOOL_NAME, {
      result: FINISH_TASK_ERROR_RESULT,
    });
    expect(isFinishTaskTerminalFr(event)).toBe(true);
  });

  it('rejects a validation-error response so the agent can retry', () => {
    const event = functionResponseEvent(FINISH_TASK_TOOL_NAME, {
      error: 'missing required parameters: summary',
    });
    expect(isFinishTaskTerminalFr(event)).toBe(false);
  });

  it('rejects a response with no payload at all', () => {
    const event = createEvent({
      author: 'worker',
      content: {
        role: 'user',
        parts: [{functionResponse: {name: FINISH_TASK_TOOL_NAME}}],
      },
    });
    expect(isFinishTaskTerminalFr(event)).toBe(false);
  });

  it('rejects an unrelated function response carrying the same result', () => {
    const event = functionResponseEvent('other_tool', {
      result: FINISH_TASK_SUCCESS_RESULT,
    });
    expect(isFinishTaskTerminalFr(event)).toBe(false);
  });

  it('rejects an event with no function response', () => {
    const event = createEvent({
      author: 'worker',
      content: {role: 'model', parts: [{text: 'done'}]},
    });
    expect(isFinishTaskTerminalFr(event)).toBe(false);
  });
});

describe('getOutputWrapperKey', () => {
  it('returns undefined when no schema is declared', () => {
    expect(getOutputWrapperKey()).toBeUndefined();
  });

  it('returns undefined for a genai object schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {summary: {type: Type.STRING}},
    };
    expect(getOutputWrapperKey(schema)).toBeUndefined();
  });

  it('returns undefined for a zod object schema', () => {
    expect(
      getOutputWrapperKey(z.object({summary: z.string()})),
    ).toBeUndefined();
  });

  it('wraps a primitive schema under result', () => {
    expect(getOutputWrapperKey(z.string())).toBe('result');
  });

  it('wraps an array schema under result', () => {
    expect(getOutputWrapperKey(z.array(z.number()))).toBe('result');
  });
});
