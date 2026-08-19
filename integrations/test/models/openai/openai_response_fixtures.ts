/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';

/** Builds a Response with the fields the SDK declares as always present. */
export function makeResponse(overrides: Partial<Response> = {}): Response {
  return {
    id: 'resp_1',
    created_at: 0,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5',
    object: 'response',
    output: [],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    ...overrides,
  };
}

/** Builds an output text block. */
export function outputText(text: string): ResponseOutputText {
  return {type: 'output_text', text, annotations: []};
}

/** Builds an assistant output message. */
export function outputMessage(
  content: ResponseOutputMessage['content'],
): ResponseOutputMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content,
  };
}

/** Builds a reasoning output item. */
export function reasoningItem(
  overrides: Partial<ResponseReasoningItem> = {},
): ResponseReasoningItem {
  return {id: 'rs_1', type: 'reasoning', summary: [], ...overrides};
}

/** Builds a function tool call output item. */
export function functionCallItem(
  overrides: Partial<ResponseFunctionToolCall> = {},
): ResponseFunctionToolCall {
  return {
    type: 'function_call',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '',
    ...overrides,
  };
}
