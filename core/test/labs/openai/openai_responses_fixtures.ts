/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixtures for the OpenAI Responses API model tests.
 *
 * The OpenAI SDK types require every field the API always sends, so building a
 * response or a stream event inline costs more lines than the assertion it
 * feeds. These builders fill the required fields and let a test name only what
 * it cares about.
 */

import {GenerateContentConfig} from '@google/genai';
import type OpenAI from 'openai';

import {
  OpenAiRequestOptions,
  OpenAiResponsesApi,
  OpenAiResponsesClient,
  ResponseCreateBody,
} from '../../../src/labs/openai/openai_responses_llm.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {LlmResponse} from '../../../src/models/llm_response.js';

/** Builds a Responses API reply, filling in the fields the API always sends. */
export function makeResponse(
  overrides: Partial<OpenAI.Responses.Response> = {},
): OpenAI.Responses.Response {
  return {
    id: 'resp_123',
    created_at: 1,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5',
    object: 'response',
    output: [],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    ...overrides,
  };
}

/** Builds an `output_text` content block. */
export function outputText(text: string): OpenAI.Responses.ResponseOutputText {
  return {type: 'output_text', text, annotations: []};
}

/** Builds a `refusal` content block. */
export function refusal(text: string): OpenAI.Responses.ResponseOutputRefusal {
  return {type: 'refusal', refusal: text};
}

/** Builds an assistant message output item. */
export function messageItem(
  content: Array<
    OpenAI.Responses.ResponseOutputText | OpenAI.Responses.ResponseOutputRefusal
  >,
  id = 'msg_1',
): OpenAI.Responses.ResponseOutputMessage {
  return {id, type: 'message', role: 'assistant', status: 'completed', content};
}

/** Builds a reasoning output item. */
export function reasoningItem(options: {
  id?: string;
  summary?: string[];
  content?: string[];
  encryptedContent?: string;
}): OpenAI.Responses.ResponseReasoningItem {
  return {
    id: options.id ?? 'rs_1',
    type: 'reasoning',
    summary: (options.summary ?? []).map((text) => ({
      type: 'summary_text',
      text,
    })),
    content: (options.content ?? []).map((text) => ({
      type: 'reasoning_text',
      text,
    })),
    encrypted_content: options.encryptedContent ?? null,
  };
}

/** Builds a function-call output item. */
export function functionCallItem(options: {
  callId?: string;
  name?: string;
  args?: string;
  id?: string;
}): OpenAI.Responses.ResponseFunctionToolCall {
  return {
    type: 'function_call',
    call_id: options.callId ?? 'call_123',
    name: options.name ?? 'get_weather',
    arguments: options.args ?? '{}',
    id: options.id,
  };
}

/** Builds a usage block. */
export function makeUsage(options: {
  input?: number;
  output?: number;
  total?: number;
  cached?: number;
  reasoning?: number;
}): OpenAI.Responses.ResponseUsage {
  return {
    input_tokens: options.input ?? 0,
    output_tokens: options.output ?? 0,
    total_tokens: options.total ?? 0,
    input_tokens_details: {
      cached_tokens: options.cached ?? 0,
      cache_write_tokens: 0,
    },
    output_tokens_details: {reasoning_tokens: options.reasoning ?? 0},
  };
}

/** Builds a `response.created` event. */
export function createdEvent(
  response: OpenAI.Responses.Response,
): OpenAI.Responses.ResponseStreamEvent {
  return {type: 'response.created', response, sequence_number: 0};
}

/** Builds a `response.output_text.delta` event. */
export function textDeltaEvent(options: {
  delta: string;
  outputIndex?: number;
  contentIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_text.delta',
    delta: options.delta,
    content_index: options.contentIndex ?? 0,
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'msg_1',
    logprobs: [],
    sequence_number: 0,
  };
}

/** Builds a `response.output_text.done` event. */
export function textDoneEvent(options: {
  text: string;
  outputIndex?: number;
  contentIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_text.done',
    text: options.text,
    content_index: options.contentIndex ?? 0,
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'msg_1',
    logprobs: [],
    sequence_number: 0,
  };
}

/** Builds a `response.content_part.done` event. */
export function contentPartDoneEvent(options: {
  part:
    | OpenAI.Responses.ResponseOutputText
    | OpenAI.Responses.ResponseOutputRefusal;
  outputIndex?: number;
  contentIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.content_part.done',
    part: options.part,
    content_index: options.contentIndex ?? 0,
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'msg_1',
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_summary_text.delta` event. */
export function reasoningSummaryDeltaEvent(options: {
  delta: string;
  outputIndex?: number;
  summaryIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_text.delta',
    delta: options.delta,
    output_index: options.outputIndex ?? 0,
    summary_index: options.summaryIndex ?? 0,
    item_id: options.itemId ?? 'rs_1',
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_summary_text.done` event. */
export function reasoningSummaryDoneEvent(options: {
  text: string;
  outputIndex?: number;
  summaryIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_text.done',
    text: options.text,
    output_index: options.outputIndex ?? 0,
    summary_index: options.summaryIndex ?? 0,
    item_id: options.itemId ?? 'rs_1',
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_summary_part.done` event. */
export function reasoningSummaryPartDoneEvent(options: {
  text: string;
  outputIndex?: number;
  summaryIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_summary_part.done',
    part: {type: 'summary_text', text: options.text},
    output_index: options.outputIndex ?? 0,
    summary_index: options.summaryIndex ?? 0,
    item_id: options.itemId ?? 'rs_1',
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_text.delta` event. */
export function reasoningTextDeltaEvent(options: {
  delta: string;
  outputIndex?: number;
  contentIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_text.delta',
    delta: options.delta,
    content_index: options.contentIndex ?? 0,
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'rs_1',
    sequence_number: 0,
  };
}

/** Builds a `response.reasoning_text.done` event. */
export function reasoningTextDoneEvent(options: {
  text: string;
  outputIndex?: number;
  contentIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.reasoning_text.done',
    text: options.text,
    content_index: options.contentIndex ?? 0,
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'rs_1',
    sequence_number: 0,
  };
}

/** Builds a `response.output_item.added` event. */
export function outputItemAddedEvent(options: {
  item: OpenAI.Responses.ResponseOutputItem;
  outputIndex?: number;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_item.added',
    item: options.item,
    output_index: options.outputIndex ?? 0,
    sequence_number: 0,
  };
}

/** Builds a `response.output_item.done` event. */
export function outputItemDoneEvent(options: {
  item: OpenAI.Responses.ResponseOutputItem;
  outputIndex?: number;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.output_item.done',
    item: options.item,
    output_index: options.outputIndex ?? 0,
    sequence_number: 0,
  };
}

/** Builds a `response.function_call_arguments.delta` event. */
export function functionArgsDeltaEvent(options: {
  delta: string;
  outputIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.function_call_arguments.delta',
    delta: options.delta,
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'fc_1',
    sequence_number: 0,
  };
}

/** Builds a `response.function_call_arguments.done` event. */
export function functionArgsDoneEvent(options: {
  args: string;
  name?: string;
  outputIndex?: number;
  itemId?: string;
}): OpenAI.Responses.ResponseStreamEvent {
  return {
    type: 'response.function_call_arguments.done',
    arguments: options.args,
    name: options.name ?? 'get_weather',
    output_index: options.outputIndex ?? 0,
    item_id: options.itemId ?? 'fc_1',
    sequence_number: 0,
  };
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

/** Yields the given events as the model's stream. */
export async function* asyncStream(
  events: OpenAI.Responses.ResponseStreamEvent[],
): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent, void> {
  for (const event of events) {
    yield event;
  }
}

/** The `responses` surface of {@link FakeResponsesClient}. */
class FakeResponsesApi implements OpenAiResponsesApi {
  body?: ResponseCreateBody;
  options?: OpenAiRequestOptions;
  calls = 0;

  constructor(
    private readonly result:
      | OpenAI.Responses.Response
      | OpenAI.Responses.ResponseStreamEvent[],
  ) {}

  create(
    body: ResponseCreateBody & {stream?: false},
    options?: OpenAiRequestOptions,
  ): Promise<OpenAI.Responses.Response>;
  create(
    body: ResponseCreateBody & {stream: true},
    options?: OpenAiRequestOptions,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  create(
    body: ResponseCreateBody,
    options?: OpenAiRequestOptions,
  ): Promise<
    | OpenAI.Responses.Response
    | AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
  > {
    this.body = body;
    this.options = options;
    this.calls += 1;
    return Promise.resolve(
      Array.isArray(this.result) ? asyncStream(this.result) : this.result,
    );
  }
}

/** A client that records the request and replays a canned reply. */
export class FakeResponsesClient implements OpenAiResponsesClient {
  readonly responses: FakeResponsesApi;

  constructor(
    result:
      | OpenAI.Responses.Response
      | OpenAI.Responses.ResponseStreamEvent[] = makeResponse(),
  ) {
    this.responses = new FakeResponsesApi(result);
  }
}

/** Builds a one-turn user request. */
export function userRequest(config: GenerateContentConfig = {}): LlmRequest {
  return {
    model: 'gpt-5',
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    config,
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Collects everything a model generator yields. */
export async function drain(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

/**
 * Returns a value as it would appear on the wire.
 *
 * `ResponseCreateBody` declares no index signature, so a field added through
 * `extraRequestArgs` is invisible to a typed read. Serializing the body is how
 * the SDK sends it, and is what a test asserting the wire shape should see.
 */
export function toWire(value: unknown): unknown {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  return serialized;
}
