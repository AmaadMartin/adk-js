/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmResponse} from '@google/adk';
import {FinishReason, Part} from '@google/genai';
import type {
  ResponseContentPartDoneEvent,
  ResponseErrorEvent,
  ResponseFailedEvent,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import {loadJsonObject} from './openai_responses_request.js';
import {
  messageContentParts,
  reasoningParts,
  ResponseLike,
  responseToLlmResponse,
  usageMetadata,
} from './openai_responses_response.js';
import {JsonObject} from './openai_schema.js';

/** A function call assembled from the events that describe it. */
interface AccumulatedCall {
  name: string;
  callId?: string;
  args: string;
}

/**
 * One output item under construction.
 *
 * Text arrives either as one run or as indexed fragments, depending on which
 * event carries it, so both forms are kept and joined at the end.
 */
interface AccumulatedItem {
  type?: string;
  text: TextBuffer;
  reasoning: TextBuffer;
  doneItem?: ResponseOutputItem;
}

/** The fields of a stream event the accumulator reads. */
interface EventInfo {
  type: string;
  outputIndex: number;
  itemId?: string;
  summaryIndex?: number;
}

/**
 * Text assembled from stream events.
 *
 * Some events number their fragments and some do not, so an unnumbered run is
 * kept separately and prefixes the numbered ones.
 */
class TextBuffer {
  private run = '';
  private fragments?: Map<number, string>;

  append(index: number | undefined, delta: string): void {
    if (index === undefined) {
      this.run += delta;
      return;
    }
    this.fragments ??= new Map();
    this.fragments.set(index, (this.fragments.get(index) ?? '') + delta);
  }

  set(index: number | undefined, text: string): void {
    if (index === undefined) {
      this.run = text;
      this.fragments = undefined;
      return;
    }
    this.fragments ??= new Map();
    this.fragments.set(index, text);
  }

  assemble(): string {
    if (!this.fragments) {
      return this.run;
    }
    const ordered = [...this.fragments.entries()].sort(([a], [b]) => a - b);
    return this.run + ordered.map(([, text]) => text).join('');
  }
}

/**
 * Turns Responses stream events into ADK responses.
 *
 * An event may produce partial responses to yield immediately, and the stream
 * as a whole produces one final response. When the stream ends without a
 * terminal `response.completed` event, the final response is rebuilt from the
 * items seen so far, in the order they arrived.
 */
export class StreamAccumulator {
  private readonly items = new Map<number, AccumulatedItem>();
  private readonly order: number[] = [];
  private readonly calls = new Map<number, AccumulatedCall>();
  private response?: ResponseLike;
  private model?: string;
  private responseId?: string;
  private usage?: ResponseUsage;
  private failed = false;
  private reasoningOpen = false;

  constructor(private readonly includeResponseMetadata: boolean) {}

  processEvent(event: ResponseStreamEvent): LlmResponse[] {
    switch (event.type) {
      case 'response.created':
        this.responseId = event.response.id;
        this.model = event.response.model;
        return [];

      case 'response.output_text.delta':
        return this.appendMessageText(
          eventInfo(event.type, event.output_index, event.item_id),
          event.content_index,
          event.delta,
        );

      case 'response.reasoning_summary_text.delta':
        return this.appendReasoningText(
          event.output_index,
          event.summary_index,
          event.delta,
        );
      case 'response.reasoning_text.delta':
        return this.appendReasoningText(
          event.output_index,
          undefined,
          event.delta,
        );

      case 'response.output_text.done':
        return this.finishMessageText(
          eventInfo(event.type, event.output_index, event.item_id),
          event.content_index,
          event.text,
        );
      case 'response.content_part.done':
        return this.finishMessageText(
          eventInfo(event.type, event.output_index, event.item_id),
          event.content_index,
          contentPartText(event.part),
        );

      case 'response.reasoning_summary_text.done':
        return this.finishReasoningText(
          eventInfo(
            event.type,
            event.output_index,
            event.item_id,
            event.summary_index,
          ),
          event.summary_index,
          event.text,
        );
      case 'response.reasoning_summary_part.done':
        return this.finishReasoningText(
          eventInfo(
            event.type,
            event.output_index,
            event.item_id,
            event.summary_index,
          ),
          event.summary_index,
          event.part.text,
        );
      case 'response.reasoning_text.done':
        return this.finishReasoningText(
          eventInfo(event.type, event.output_index, event.item_id),
          undefined,
          event.text,
        );

      case 'response.output_item.added':
        return this.trackOutputItem(
          eventInfo(event.type, event.output_index),
          event.item,
          false,
        );
      case 'response.output_item.done':
        return this.trackOutputItem(
          eventInfo(event.type, event.output_index),
          event.item,
          true,
        );

      case 'response.function_call_arguments.delta':
        return this.appendCallArguments(
          eventInfo(event.type, event.output_index, event.item_id),
          event.delta,
        );
      case 'response.function_call_arguments.done':
        return this.replaceCallArguments(
          eventInfo(event.type, event.output_index, event.item_id),
          event.arguments,
          event.name,
        );

      case 'response.completed':
      case 'response.incomplete':
        this.response = event.response;
        this.usage = event.response.usage ?? this.usage;
        return [];

      case 'response.failed':
      case 'error':
        return this.fail(event);

      default:
        return [];
    }
  }

  /**
   * Returns the response that closes the stream, or `undefined` when there is
   * none.
   *
   * A failed stream already yielded its error response and must not follow it
   * with a contradictory success.
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
      usageMetadata: usageMetadata(this.usage),
    };
  }

  private appendMessageText(
    info: EventInfo,
    contentIndex: number,
    delta: string,
  ): LlmResponse[] {
    const closing = this.closeReasoningStream(info);
    this.ensureItem(info.outputIndex, 'message').text.append(
      contentIndex,
      delta,
    );
    return [...closing, this.partialResponse({text: delta})];
  }

  private appendReasoningText(
    outputIndex: number,
    summaryIndex: number | undefined,
    delta: string,
  ): LlmResponse[] {
    this.reasoningOpen = true;
    this.ensureItem(outputIndex, 'reasoning').reasoning.append(
      summaryIndex,
      delta,
    );
    return [this.partialResponse({text: delta, thought: true})];
  }

  private finishMessageText(
    info: EventInfo,
    contentIndex: number,
    text: string,
  ): LlmResponse[] {
    const closing = this.closeReasoningStream(info);
    const item = this.ensureItem(info.outputIndex, 'message');
    if (text) {
      item.text.set(contentIndex, text);
    }
    return closing;
  }

  private finishReasoningText(
    info: EventInfo,
    summaryIndex: number | undefined,
    text: string,
  ): LlmResponse[] {
    const item = this.ensureItem(info.outputIndex, 'reasoning');
    if (text) {
      item.reasoning.set(summaryIndex, text);
    }
    return this.closeReasoningStream(info);
  }

  private trackOutputItem(
    info: EventInfo,
    item: ResponseOutputItem,
    done: boolean,
  ): LlmResponse[] {
    const closing =
      item.type === 'reasoning' ? [] : this.closeReasoningStream(info);
    const accumulated = this.ensureItem(info.outputIndex, item.type);
    if (done) {
      accumulated.doneItem = item;
    }
    if (item.type === 'function_call') {
      this.mergeFunctionCall(info.outputIndex, item);
    }
    return closing;
  }

  private appendCallArguments(info: EventInfo, delta: string): LlmResponse[] {
    const closing = this.closeReasoningStream(info);
    const call = this.ensureCall(info.outputIndex, '');
    call.args += delta;
    return closing;
  }

  private replaceCallArguments(
    info: EventInfo,
    args: string,
    name: string,
  ): LlmResponse[] {
    const closing = this.closeReasoningStream(info);
    this.ensureCall(info.outputIndex, name).args = args;
    return closing;
  }

  /**
   * Merges a function call output item into what the deltas already
   * assembled.
   *
   * A done item may omit fields that were already streamed, so an absent field
   * keeps the accumulated value rather than clearing it.
   */
  private mergeFunctionCall(
    outputIndex: number,
    item: ResponseFunctionToolCall,
  ): void {
    const existing = this.calls.get(outputIndex);
    this.calls.set(outputIndex, {
      name: item.name || existing?.name || '',
      callId: item.call_id || item.id || existing?.callId,
      args: item.arguments || existing?.args || '',
    });
  }

  private fail(event: ResponseFailedEvent | ResponseErrorEvent): LlmResponse[] {
    this.failed = true;
    return [
      {
        errorCode: FinishReason.OTHER,
        errorMessage: JSON.stringify(event),
        finishReason: FinishReason.OTHER,
        interactionId: this.responseId,
      },
    ];
  }

  /**
   * Emits the marker that separates streamed reasoning from what follows it.
   *
   * Both arrive as partial responses, so without the marker a consumer cannot
   * tell where the model stopped thinking and started answering.
   */
  private closeReasoningStream(info: EventInfo): LlmResponse[] {
    if (!this.reasoningOpen) {
      return [];
    }
    this.reasoningOpen = false;
    if (!this.includeResponseMetadata) {
      return [];
    }
    const streamEvent: JsonObject = {
      type: info.type,
      reasoning_done: true,
      output_index: info.outputIndex,
    };
    if (info.itemId !== undefined) {
      streamEvent['item_id'] = info.itemId;
    }
    if (info.summaryIndex !== undefined) {
      streamEvent['summary_index'] = info.summaryIndex;
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

  private ensureItem(outputIndex: number, type?: string): AccumulatedItem {
    let item = this.items.get(outputIndex);
    if (!item) {
      item = {text: new TextBuffer(), reasoning: new TextBuffer()};
      this.items.set(outputIndex, item);
      this.order.push(outputIndex);
    }
    item.type ??= type;
    return item;
  }

  private ensureCall(outputIndex: number, name: string): AccumulatedCall {
    this.ensureItem(outputIndex, 'function_call');
    let call = this.calls.get(outputIndex);
    if (!call) {
      call = {name, args: ''};
      this.calls.set(outputIndex, call);
    }
    return call;
  }

  /** Rebuilds the response parts from the items, in the order they arrived. */
  private assembleParts(): Part[] {
    const parts: Part[] = [];
    for (const outputIndex of this.order) {
      parts.push(...this.itemParts(outputIndex));
    }
    return parts;
  }

  /** Returns the parts of one accumulated output item. */
  private itemParts(outputIndex: number): Part[] {
    const item = this.ensureItem(outputIndex);
    const doneItem = item.doneItem;
    if (doneItem?.type === 'message') {
      const parts = messageContentParts(doneItem);
      if (parts.length > 0) {
        return parts;
      }
    }
    if (doneItem?.type === 'reasoning') {
      const {parts} = reasoningParts(doneItem);
      if (parts.length > 0) {
        return parts;
      }
    }
    const type = doneItem?.type ?? item.type;
    if (type === 'reasoning') {
      const text = item.reasoning.assemble();
      return text ? [{text, thought: true}] : [];
    }
    if (type === 'message') {
      const text = item.text.assemble();
      return text ? [{text}] : [];
    }
    const call = this.calls.get(outputIndex);
    if (type === 'function_call' && call) {
      return [callPart(call)];
    }
    return [];
  }
}

/** Collects the event fields the accumulator needs into one record. */
function eventInfo(
  type: string,
  outputIndex: number,
  itemId?: string,
  summaryIndex?: number,
): EventInfo {
  return {type, outputIndex, itemId, summaryIndex};
}

/** Returns the text of a finished content part, if it carries any. */
function contentPartText(part: ResponseContentPartDoneEvent['part']): string {
  return 'text' in part ? part.text : '';
}

/** Converts an accumulated function call into an ADK part. */
function callPart(call: AccumulatedCall): Part {
  return {
    functionCall: {
      id: call.callId,
      name: call.name,
      args: loadJsonObject(call.args),
    },
  };
}
