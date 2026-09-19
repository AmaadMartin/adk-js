/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Accumulation of an OpenAI Responses API event stream.
 *
 * Ported from `_StreamAccumulator` in
 * `src/google/adk/labs/openai/_openai_responses_llm.py` in google/adk-python.
 */

import {FinishReason, Part} from '@google/genai';

import {LlmResponse} from '../../models/llm_response.js';

import {
  loadsJsonObject,
  messageContentParts,
  OpenAIOutputItem,
  OpenAIResponse,
  OpenAIStreamEvent,
  OpenAIUsage,
  optional,
  reasoningItemParts,
  responseToLlmResponse,
  toUsageMetadata,
} from './openai_responses_converters.js';

/** Output key used when an event carries no index, id or fallback. */
const DEFAULT_OUTPUT_KEY = 'output';

/** Identifies one streamed output item across the events that build it. */
type OutputKey = string | number;

/** A function call assembled from the events that describe it. */
interface StreamedFunctionCall {
  name: string;
  callId?: string;
  arguments: string;
}

/**
 * The text one streamed output item accumulated.
 *
 * The API sends text either as bare deltas or as deltas addressed by
 * `content_index` / `summary_index`. One item never mixes the two, so both
 * forms are kept and joined in index order at the end.
 */
class StreamedText {
  private plain = '';
  private readonly indexed = new Map<number, string>();

  /** Appends a delta, to the indexed slot when the event named one. */
  append(index: number | undefined, delta: string): void {
    if (index === undefined) {
      this.plain += delta;
      return;
    }
    this.indexed.set(index, (this.indexed.get(index) ?? '') + delta);
  }

  /** Replaces the accumulated text with the authoritative final text. */
  set(index: number | undefined, text: string): void {
    if (index === undefined) {
      this.plain = text;
      this.indexed.clear();
      return;
    }
    this.indexed.set(index, text);
  }

  /** Returns the accumulated text in ascending index order. */
  value(): string {
    const ordered = [...this.indexed.entries()].sort(
      ([left], [right]) => left - right,
    );
    return this.plain + ordered.map(([, text]) => text).join('');
  }
}

/** One output item being assembled from the stream. */
interface StreamedOutputItem {
  type?: string;
  text: StreamedText;
  doneItem?: OpenAIOutputItem;
}

/** Resolves the key that identifies the output item an event belongs to. */
function streamOutputKey(
  event: OpenAIStreamEvent,
  fallback?: OutputKey,
): OutputKey {
  if (typeof event.output_index === 'number') {
    return event.output_index;
  }
  if (typeof event.item_id === 'string') {
    return event.item_id;
  }
  return fallback ?? DEFAULT_OUTPUT_KEY;
}

/** Builds the ADK part for a function call assembled from the stream. */
function streamedFunctionCallPart(call: StreamedFunctionCall): Part {
  return {
    functionCall: {
      id: call.callId,
      name: call.name,
      args: loadsJsonObject(call.arguments),
    },
  };
}

/**
 * Turns a Responses API event stream into ADK responses.
 *
 * The accumulator emits the partial responses a caller should forward as each
 * event arrives, and holds the state needed to build the final response once
 * the stream ends.
 */
export class ResponsesStreamAccumulator {
  private readonly outputItems = new Map<OutputKey, StreamedOutputItem>();
  private readonly functionCalls = new Map<OutputKey, StreamedFunctionCall>();
  private response?: OpenAIResponse;
  private model?: string;
  private responseId?: string;
  private usage?: OpenAIUsage;
  private failed = false;
  private reasoningOpen = false;

  constructor(private readonly includeResponseMetadata: boolean) {}

  /** Records one event and returns the responses it produces. */
  processEvent(event: OpenAIStreamEvent): LlmResponse[] {
    switch (event.type) {
      case 'response.created':
        this.responseId = optional(event.response?.id);
        this.model = optional(event.response?.model);
        return [];
      case 'response.output_text.delta':
        return [...this.closeReasoning(event), this.appendText(event)];
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return [this.appendReasoning(event)];
      case 'response.output_item.added':
        return this.onOutputItem(event, false);
      case 'response.content_part.done':
      case 'response.output_text.done':
        return this.onTextDone(event);
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_part.done':
        return this.onReasoningDone(event);
      case 'response.function_call_arguments.delta':
        return this.onFunctionArgumentsDelta(event);
      case 'response.function_call_arguments.done':
        return this.onFunctionArgumentsDone(event);
      case 'response.output_item.done':
        return this.onOutputItem(event, true);
      case 'response.completed':
      case 'response.incomplete':
        this.response = optional(event.response);
        this.usage = optional(event.response?.usage) ?? this.usage;
        return [];
      case 'response.failed':
      case 'error':
        return [this.onFailure(event)];
      default:
        return [];
    }
  }

  /**
   * Returns the response that closes the stream, if there is one.
   *
   * A stream that failed has already reported the failure. A stream that
   * completed carries its own response object. Otherwise the response is
   * rebuilt from the accumulated items, in the order they were opened.
   */
  finalResponse(): LlmResponse | undefined {
    if (this.failed) {
      return undefined;
    }
    if (this.response) {
      return responseToLlmResponse(this.response, {
        includeResponseMetadata: this.includeResponseMetadata,
      });
    }
    const parts = this.assembleParts();
    if (parts.length === 0) {
      return undefined;
    }
    return {
      content: {role: 'model', parts},
      partial: false,
      finishReason: FinishReason.STOP,
      interactionId: this.responseId,
      modelVersion: this.model,
      usageMetadata: toUsageMetadata(this.usage),
    };
  }

  private appendText(event: OpenAIStreamEvent): LlmResponse {
    const delta = event.delta ?? '';
    const item = this.ensureOutputItem(
      streamOutputKey(event, 'message'),
      'message',
    );
    item.text.append(optional(event.content_index), delta);
    return this.partialResponse({text: delta});
  }

  private appendReasoning(event: OpenAIStreamEvent): LlmResponse {
    const delta = event.delta ?? '';
    this.reasoningOpen = true;
    const item = this.ensureOutputItem(
      streamOutputKey(event, 'reasoning'),
      'reasoning',
    );
    item.text.append(optional(event.summary_index), delta);
    return this.partialResponse({text: delta, thought: true});
  }

  /**
   * Opens the output item an event describes, and closes it when `done`.
   *
   * A reasoning item does not end an open run of reasoning deltas; every other
   * kind does.
   */
  private onOutputItem(event: OpenAIStreamEvent, done: boolean): LlmResponse[] {
    const item = event.item;
    const responses =
      item?.type === 'reasoning' ? [] : this.closeReasoning(event);
    const key = streamOutputKey(event, optional(item?.call_id));
    const outputItem = this.ensureOutputItem(key, optional(item?.type));
    if (done) {
      outputItem.doneItem = optional(item);
    }
    if (item?.type === 'function_call') {
      this.trackFunctionCall(key, item);
    }
    return responses;
  }

  private onTextDone(event: OpenAIStreamEvent): LlmResponse[] {
    const responses = this.closeReasoning(event);
    const item = this.ensureOutputItem(
      streamOutputKey(event, 'message'),
      'message',
    );
    const text = event.text || event.part?.text;
    if (text) {
      item.text.set(optional(event.content_index), text);
    }
    return responses;
  }

  private onReasoningDone(event: OpenAIStreamEvent): LlmResponse[] {
    const item = this.ensureOutputItem(
      streamOutputKey(event, 'reasoning'),
      'reasoning',
    );
    const text = event.text || event.part?.text;
    if (text) {
      item.text.set(optional(event.summary_index), text);
    }
    return this.closeReasoning(event);
  }

  private onFunctionArgumentsDelta(event: OpenAIStreamEvent): LlmResponse[] {
    const responses = this.closeReasoning(event);
    const key = streamOutputKey(event, optional(event.call_id));
    this.ensureOutputItem(key, 'function_call');
    this.pendingFunctionCall(key, event).arguments += event.delta ?? '';
    return responses;
  }

  private onFunctionArgumentsDone(event: OpenAIStreamEvent): LlmResponse[] {
    const responses = this.closeReasoning(event);
    const key = streamOutputKey(event, optional(event.call_id));
    this.ensureOutputItem(key, 'function_call');
    const call = this.pendingFunctionCall(key, event);
    const streamedArguments = optional(event.arguments);
    if (streamedArguments !== undefined) {
      call.arguments = streamedArguments;
    }
    return responses;
  }

  private onFailure(event: OpenAIStreamEvent): LlmResponse {
    this.failed = true;
    return {
      errorCode: FinishReason.OTHER,
      errorMessage: JSON.stringify(event),
      finishReason: FinishReason.OTHER,
      interactionId: this.responseId,
    };
  }

  /**
   * Ends an open run of reasoning deltas.
   *
   * The boundary is reported as a metadata-only partial response, so a caller
   * can tell where the model stopped reasoning and started answering.
   */
  private closeReasoning(event: OpenAIStreamEvent): LlmResponse[] {
    if (!this.reasoningOpen) {
      return [];
    }
    this.reasoningOpen = false;
    if (!this.includeResponseMetadata) {
      return [];
    }
    const streamEvent: Record<string, unknown> = {
      type: event.type,
      reasoning_done: true,
    };
    if (event.output_index !== undefined) {
      streamEvent['output_index'] = event.output_index;
    }
    if (event.item_id !== undefined) {
      streamEvent['item_id'] = event.item_id;
    }
    if (event.summary_index !== undefined) {
      streamEvent['summary_index'] = event.summary_index;
    }
    return [
      {
        partial: true,
        modelVersion: this.model,
        interactionId: this.responseId,
        customMetadata: {openai_response: {stream_event: streamEvent}},
      },
    ];
  }

  private partialResponse(part: Part): LlmResponse {
    return {
      content: {role: 'model', parts: [part]},
      partial: true,
      modelVersion: this.model,
      interactionId: this.responseId,
    };
  }

  private ensureOutputItem(
    key: OutputKey,
    itemType?: string,
  ): StreamedOutputItem {
    let item = this.outputItems.get(key);
    if (!item) {
      item = {text: new StreamedText()};
      this.outputItems.set(key, item);
    }
    if (itemType && item.type === undefined) {
      item.type = itemType;
    }
    return item;
  }

  private pendingFunctionCall(
    key: OutputKey,
    event: OpenAIStreamEvent,
  ): StreamedFunctionCall {
    let call = this.functionCalls.get(key);
    if (!call) {
      call = {
        name: event.name ?? '',
        callId: optional(event.call_id),
        arguments: '',
      };
      this.functionCalls.set(key, call);
    }
    return call;
  }

  /**
   * Records the function call an output item describes.
   *
   * A `done` item may omit fields that already arrived as deltas, so what was
   * streamed is kept whenever the item does not restate it.
   */
  private trackFunctionCall(key: OutputKey, item: OpenAIOutputItem): void {
    this.ensureOutputItem(key, 'function_call');
    const streamed = this.functionCalls.get(key);
    this.functionCalls.set(key, {
      name: item.name || streamed?.name || '',
      callId: item.call_id || item.id || streamed?.callId || undefined,
      arguments: item.arguments || streamed?.arguments || '',
    });
  }

  private assembleParts(): Part[] {
    // Every tracked function call opens an output item under the same key, so
    // iterating the items covers all of them.
    const parts: Part[] = [];
    for (const [key, item] of this.outputItems) {
      parts.push(...this.outputItemParts(key, item));
    }
    return parts;
  }

  private outputItemParts(key: OutputKey, item: StreamedOutputItem): Part[] {
    const doneItem = item.doneItem;
    const itemType = doneItem?.type ?? item.type;
    if (doneItem && itemType === 'message') {
      const messageParts = messageContentParts(doneItem);
      if (messageParts.length > 0) {
        return messageParts;
      }
    }
    if (doneItem && itemType === 'reasoning') {
      const {parts} = reasoningItemParts(doneItem);
      if (parts.length > 0) {
        return parts;
      }
    }
    if (itemType === 'reasoning') {
      const text = item.text.value();
      return text ? [{text, thought: true}] : [];
    }
    if (itemType === 'message') {
      const text = item.text.value();
      return text ? [{text}] : [];
    }
    const call = this.functionCalls.get(key);
    if (itemType === 'function_call' && call) {
      return [streamedFunctionCallPart(call)];
    }
    return [];
  }
}

/**
 * Reads a Responses API event stream as ADK responses.
 *
 * @param events The raw event stream the client returned.
 * @param includeResponseMetadata Whether to keep the raw payload on the
 *   responses, and to report the reasoning boundary.
 * @return Each partial as it arrives, then the final response if there is one.
 */
export async function* streamResponses(
  events: AsyncIterable<OpenAIStreamEvent>,
  includeResponseMetadata: boolean,
): AsyncGenerator<LlmResponse, void> {
  const accumulator = new ResponsesStreamAccumulator(includeResponseMetadata);
  for await (const event of events) {
    yield* accumulator.processEvent(event);
  }
  const finalResponse = accumulator.finalResponse();
  if (finalResponse) {
    yield finalResponse;
  }
}
