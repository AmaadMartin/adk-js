/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test doubles and fixture factories for the OpenAI Responses model tests.
 *
 * The SDK's response and event types carry fields the converters never read,
 * so a fixture built by hand is mostly noise. These factories fill the noise
 * in and leave each test stating only what it is about.
 */

import type {
  OpenAIResponses,
  OpenAIResponsesClient,
  ResponsesRequestBody,
} from '@google/adk';
import type {OpenAI} from 'openai';
import {expect} from 'vitest';

/** One recorded call to `responses.create`. */
export interface RecordedCall {
  body: ResponsesRequestBody;
  options?: {signal?: AbortSignal};
}

/** What a {@link FakeResponsesClient} replies with. */
export type FakeResult =
  | {response: OpenAI.Responses.Response}
  | {events: OpenAI.Responses.ResponseStreamEvent[]};

/** Yields `events` as the SDK's stream does. */
async function* asyncEvents(
  events: OpenAI.Responses.ResponseStreamEvent[],
): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent, void> {
  for (const event of events) {
    yield event;
  }
}

/** A `responses` surface that records every call and replays a canned reply. */
class FakeResponses implements OpenAIResponses {
  constructor(
    private readonly calls: RecordedCall[],
    private readonly result: FakeResult,
  ) {}

  create(
    body: ResponsesRequestBody & {stream?: false | null},
    options?: {signal?: AbortSignal},
  ): Promise<OpenAI.Responses.Response>;
  create(
    body: ResponsesRequestBody & {stream: true},
    options?: {signal?: AbortSignal},
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  async create(
    body: ResponsesRequestBody,
    options?: {signal?: AbortSignal},
  ): Promise<
    | OpenAI.Responses.Response
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
  > {
    this.calls.push({body, options});
    return 'response' in this.result
      ? this.result.response
      : asyncEvents(this.result.events);
  }
}

/** An {@link OpenAIResponsesClient} that records what the model sent it. */
export class FakeResponsesClient implements OpenAIResponsesClient {
  readonly calls: RecordedCall[] = [];
  readonly responses: OpenAIResponses;

  constructor(result: FakeResult) {
    this.responses = new FakeResponses(this.calls, result);
  }

  /** The single call the client received. */
  get onlyCall(): RecordedCall {
    const [call, ...rest] = this.calls;
    if (!call || rest.length > 0) {
      expect.fail(`expected exactly one call, got ${this.calls.length}`);
    }
    return call;
  }

  /** The body of the single call the client received. */
  get body(): ResponsesRequestBody {
    return this.onlyCall.body;
  }
}

/** Builds a `Response`, filling in the fields the converters never read. */
export function makeResponse(
  partial: Partial<OpenAI.Responses.Response>,
): OpenAI.Responses.Response {
  return {
    id: 'resp_123',
    created_at: 0,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5',
    object: 'response',
    output: [],
    output_text: '',
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    ...partial,
  };
}

/** Builds a `ResponseUsage`, filling in the details blocks. */
export function makeUsage(
  partial: Partial<OpenAI.Responses.ResponseUsage>,
): OpenAI.Responses.ResponseUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    ...partial,
    input_tokens_details: {
      cache_write_tokens: 0,
      cached_tokens: 0,
      ...partial.input_tokens_details,
    },
    output_tokens_details: {
      reasoning_tokens: 0,
      ...partial.output_tokens_details,
    },
  };
}

/** Builds an output message item. */
export function messageItem(
  text: string,
  id = 'msg_1',
): OpenAI.Responses.ResponseOutputMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{type: 'output_text', text, annotations: []}],
  };
}

/** Builds a reasoning output item. */
export function reasoningItem(
  partial: Partial<OpenAI.Responses.ResponseReasoningItem>,
): OpenAI.Responses.ResponseReasoningItem {
  return {id: 'rs_1', type: 'reasoning', summary: [], ...partial};
}

/** Builds a function-call output item. */
export function functionCallItem(
  partial: Partial<OpenAI.Responses.ResponseFunctionToolCall>,
): OpenAI.Responses.ResponseFunctionToolCall {
  return {
    type: 'function_call',
    call_id: 'call_123',
    name: 'get_weather',
    arguments: '{}',
    ...partial,
  };
}

/** Builds a `response.created` event. */
export function createdEvent(
  response: OpenAI.Responses.Response,
): OpenAI.Responses.ResponseStreamEvent {
  return {type: 'response.created', response, sequence_number: 0};
}

/** Builds a `response.completed` event. */
export function completedEvent(
  response: OpenAI.Responses.Response,
): OpenAI.Responses.ResponseStreamEvent {
  return {type: 'response.completed', response, sequence_number: 0};
}

/** Builds a `response.incomplete` event. */
export function incompleteEvent(
  response: OpenAI.Responses.Response,
): OpenAI.Responses.ResponseStreamEvent {
  return {type: 'response.incomplete', response, sequence_number: 0};
}

/** Builds a `response.failed` event. */
export function failedEvent(
  response: OpenAI.Responses.Response,
): OpenAI.Responses.ResponseStreamEvent {
  return {type: 'response.failed', response, sequence_number: 0};
}

/** Builds a `response.output_text.delta` event. */
export function textDeltaEvent(
  outputIndex: number,
  delta: string,
  contentIndex = 0,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_text.delta',
    delta,
    content_index: contentIndex,
    item_id: `msg_${outputIndex}`,
    output_index: outputIndex,
    logprobs: [],
    sequence_number: 0,
  };
}

/** Builds a `response.output_text.done` event. */
export function textDoneEvent(
  outputIndex: number,
  text: string,
  contentIndex = 0,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_text.done',
    text,
    content_index: contentIndex,
    item_id: `msg_${outputIndex}`,
    output_index: outputIndex,
    logprobs: [],
    sequence_number: 0,
  };
}

/** Builds a `response.content_part.done` event carrying output text. */
export function contentPartDoneEvent(
  outputIndex: number,
  text: string,
  contentIndex = 0,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.content_part.done',
    part: {type: 'output_text', text, annotations: []},
    content_index: contentIndex,
    item_id: `msg_${outputIndex}`,
    output_index: outputIndex,
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_summary_text.delta` event. */
export function summaryDeltaEvent(
  outputIndex: number,
  delta: string,
  summaryIndex = 0,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_text.delta',
    delta,
    item_id: `rs_${outputIndex}`,
    output_index: outputIndex,
    summary_index: summaryIndex,
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_summary_text.done` event. */
export function summaryDoneEvent(
  outputIndex: number,
  text: string,
  summaryIndex = 0,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_text.done',
    text,
    item_id: `rs_${outputIndex}`,
    output_index: outputIndex,
    summary_index: summaryIndex,
    sequence_number: 0,
  };
}

/** Builds a `response.output_item.added` event. */
export function itemAddedEvent(
  outputIndex: number,
  item: OpenAI.Responses.ResponseOutputItem,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_item.added',
    item,
    output_index: outputIndex,
    sequence_number: 0,
  };
}

/** Builds a `response.output_item.done` event. */
export function itemDoneEvent(
  outputIndex: number,
  item: OpenAI.Responses.ResponseOutputItem,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_item.done',
    item,
    output_index: outputIndex,
    sequence_number: 0,
  };
}

/** Builds a `response.function_call_arguments.delta` event. */
export function argumentsDeltaEvent(
  outputIndex: number,
  delta: string,
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.function_call_arguments.delta',
    delta,
    item_id: `fc_${outputIndex}`,
    output_index: outputIndex,
    sequence_number: 0,
  };
}

/** Builds a `response.function_call_arguments.done` event. */
export function argumentsDoneEvent(
  outputIndex: number,
  argumentsJson: string,
  name = 'get_weather',
): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.function_call_arguments.done',
    arguments: argumentsJson,
    name,
    item_id: `fc_${outputIndex}`,
    output_index: outputIndex,
    sequence_number: 0,
  };
}
