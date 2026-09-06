/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Accumulates an OpenAI Responses API event stream into ADK responses.
 *
 * Ports `_StreamAccumulator` from adk-python
 * `src/google/adk/labs/openai/_openai_responses_llm.py`.
 */

import {FinishReason, Part} from '@google/genai';
import type OpenAI from 'openai';

import {LlmResponse} from '../../models/llm_response.js';

import {
  loadsJsonObject,
  messageContentParts,
  reasoningParts,
  responseToLlmResponse,
} from './openai_responses_response.js';

/** One output item of the response, as the stream builds it up. */
interface StreamOutputItem {
  type?: string;
  doneItem?: OpenAI.Responses.ResponseOutputItem;
  /** Text by content index. */
  textParts: Map<number, string>;
  /** Reasoning that arrived without a summary index. */
  reasoning: string;
  /** Reasoning by summary index. */
  reasoningParts: Map<number, string>;
}

/** One function call of the response, as the stream builds it up. */
interface StreamFunctionCall {
  name: string;
  callId?: string;
  arguments: string;
}

/** The metadata emitted when a run of reasoning deltas ends. */
interface ReasoningBoundary {
  type: string;
  reasoning_done: true;
  output_index?: number;
  item_id?: string;
  summary_index?: number;
}

/** Returns an empty accumulator entry for one output item. */
function newOutputItem(): StreamOutputItem {
  return {
    textParts: new Map(),
    reasoning: '',
    reasoningParts: new Map(),
  };
}

/** Joins the indexed fragments of a text field, in index order. */
function assembledText(parts: Map<number, string>): string {
  const indexes = [...parts.keys()].sort((a, b) => a - b);
  return indexes.map((index) => parts.get(index)).join('');
}

/** Converts an accumulated function call into an ADK function-call part. */
function accumulatedFunctionCallPart(call: StreamFunctionCall): Part {
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
 * The accumulator owns the state of one streamed response: the partial output
 * items, the function calls being assembled, and whether a run of reasoning
 * deltas is currently open. Feed it every event with {@link
 * StreamAccumulator.processEvent}, then ask for {@link
 * StreamAccumulator.finalResponse} once the stream ends.
 */
export class StreamAccumulator {
  private readonly outputItems = new Map<number, StreamOutputItem>();
  private readonly functionCalls = new Map<number, StreamFunctionCall>();
  private response?: OpenAI.Responses.Response;
  private model?: string;
  private responseId?: string;
  private failed = false;
  private reasoningOpen = false;

  constructor(private readonly includeResponseMetadata: boolean) {}

  /**
   * Consumes one stream event.
   *
   * @return The responses to yield for this event, which may be empty.
   */
  processEvent(event: OpenAI.Responses.ResponseStreamEvent): LlmResponse[] {
    switch (event.type) {
      case 'response.created':
        this.responseId = event.response.id;
        this.model = event.response.model;
        return [];
      case 'response.output_text.delta': {
        const responses = this.closeReasoningStream(event);
        const item = this.ensureOutputItem(event.output_index, 'message');
        appendIndexed(item.textParts, event.content_index, event.delta);
        responses.push(this.partial({text: event.delta}));
        return responses;
      }
      case 'response.reasoning_summary_text.delta':
        this.reasoningOpen = true;
        appendIndexed(
          this.ensureOutputItem(event.output_index, 'reasoning').reasoningParts,
          event.summary_index,
          event.delta,
        );
        return [this.partial({text: event.delta, thought: true})];
      case 'response.reasoning_text.delta': {
        this.reasoningOpen = true;
        const item = this.ensureOutputItem(event.output_index, 'reasoning');
        item.reasoning += event.delta;
        return [this.partial({text: event.delta, thought: true})];
      }
      case 'response.output_item.added': {
        const responses = this.closeReasoningUnlessReasoningItem(event);
        this.ensureOutputItem(event.output_index, event.item.type);
        this.trackFunctionCallItem(event.output_index, event.item);
        return responses;
      }
      case 'response.output_text.done': {
        const responses = this.closeReasoningStream(event);
        this.setMessageText(
          event.output_index,
          event.content_index,
          event.text,
        );
        return responses;
      }
      case 'response.content_part.done': {
        const responses = this.closeReasoningStream(event);
        const text = 'text' in event.part ? event.part.text : '';
        this.setMessageText(event.output_index, event.content_index, text);
        return responses;
      }
      case 'response.reasoning_summary_text.done':
        this.setReasoningText(
          event.output_index,
          event.summary_index,
          event.text,
        );
        return this.closeReasoningStream(event);
      case 'response.reasoning_summary_part.done':
        this.setReasoningText(
          event.output_index,
          event.summary_index,
          event.part.text,
        );
        return this.closeReasoningStream(event);
      case 'response.reasoning_text.done': {
        const item = this.ensureOutputItem(event.output_index, 'reasoning');
        if (event.text) {
          item.reasoning = event.text;
          item.reasoningParts.clear();
        }
        return this.closeReasoningStream(event);
      }
      case 'response.function_call_arguments.delta': {
        const responses = this.closeReasoningStream(event);
        this.ensureFunctionCall(event.output_index).arguments += event.delta;
        return responses;
      }
      case 'response.function_call_arguments.done': {
        const responses = this.closeReasoningStream(event);
        const call = this.ensureFunctionCall(event.output_index);
        call.name = call.name || event.name;
        call.arguments = event.arguments;
        return responses;
      }
      case 'response.output_item.done': {
        const responses = this.closeReasoningUnlessReasoningItem(event);
        const item = this.ensureOutputItem(event.output_index, event.item.type);
        item.doneItem = event.item;
        this.trackFunctionCallItem(event.output_index, event.item);
        return responses;
      }
      case 'response.completed':
      case 'response.incomplete':
        this.response = event.response;
        return [];
      case 'response.failed':
      case 'error':
        this.failed = true;
        return [
          {
            errorCode: FinishReason.OTHER,
            errorMessage: JSON.stringify(event),
            finishReason: FinishReason.OTHER,
            interactionId: this.responseId,
          },
        ];
      default:
        return [];
    }
  }

  /**
   * Returns the response that closes the stream.
   *
   * @return The response the API sent, or one reconstructed from the events
   *   when the stream ended without a terminal response. `undefined` when the
   *   stream failed or produced no content at all.
   */
  finalResponse(): LlmResponse | undefined {
    if (this.failed) {
      return undefined;
    }
    if (this.response) {
      return responseToLlmResponse(this.response, this.includeResponseMetadata);
    }

    // Every function call is registered as an output item as it arrives, so
    // walking the output items in order covers them too.
    const parts: Part[] = [];
    for (const [key, item] of this.outputItems) {
      parts.push(...this.accumulatedParts(key, item));
    }
    if (parts.length === 0) {
      return undefined;
    }
    return {
      content: {role: 'model', parts},
      partial: false,
      finishReason: FinishReason.STOP,
      interactionId: this.responseId,
      modelVersion: this.model,
    };
  }

  /** Returns the ADK parts of one accumulated output item. */
  private accumulatedParts(key: number, item: StreamOutputItem): Part[] {
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
    const itemType = doneItem?.type ?? item.type;
    if (itemType === 'reasoning') {
      const text = item.reasoning + assembledText(item.reasoningParts);
      return text ? [{text, thought: true}] : [];
    }
    if (itemType === 'message') {
      const text = assembledText(item.textParts);
      return text ? [{text}] : [];
    }
    const call = this.functionCalls.get(key);
    if (itemType === 'function_call' && call) {
      return [accumulatedFunctionCallPart(call)];
    }
    return [];
  }

  /** Builds a partial response carrying one streamed part. */
  private partial(part: Part): LlmResponse {
    return {
      content: {role: 'model', parts: [part]},
      partial: true,
      modelVersion: this.model,
      interactionId: this.responseId,
    };
  }

  /** Returns the accumulator entry for an output index, creating it if new. */
  private ensureOutputItem(key: number, itemType?: string): StreamOutputItem {
    let item = this.outputItems.get(key);
    if (!item) {
      item = newOutputItem();
      this.outputItems.set(key, item);
    }
    item.type ??= itemType;
    return item;
  }

  /** Returns the function call for an output index, creating it if new. */
  private ensureFunctionCall(key: number): StreamFunctionCall {
    this.ensureOutputItem(key, 'function_call');
    let call = this.functionCalls.get(key);
    if (!call) {
      call = {name: '', arguments: ''};
      this.functionCalls.set(key, call);
    }
    return call;
  }

  /** Records a function-call output item, keeping already streamed fields. */
  private trackFunctionCallItem(
    key: number,
    item: OpenAI.Responses.ResponseOutputItem,
  ): void {
    if (item.type !== 'function_call') {
      return;
    }
    const call = this.ensureFunctionCall(key);
    call.name = item.name || call.name;
    call.callId = item.call_id || item.id || call.callId;
    call.arguments = item.arguments || call.arguments;
  }

  /** Replaces the text of a message output item at a content index. */
  private setMessageText(key: number, index: number, text: string): void {
    if (text) {
      this.ensureOutputItem(key, 'message').textParts.set(index, text);
    }
  }

  /** Replaces the reasoning of an output item at a summary index. */
  private setReasoningText(key: number, index: number, text: string): void {
    if (text) {
      this.ensureOutputItem(key, 'reasoning').reasoningParts.set(index, text);
    }
  }

  /**
   * Closes an open run of reasoning deltas unless the event introduces another
   * reasoning item, which continues the run.
   */
  private closeReasoningUnlessReasoningItem(
    event:
      | OpenAI.Responses.ResponseOutputItemAddedEvent
      | OpenAI.Responses.ResponseOutputItemDoneEvent,
  ): LlmResponse[] {
    return event.item.type === 'reasoning'
      ? []
      : this.closeReasoningStream(event);
  }

  /**
   * Ends an open run of reasoning deltas.
   *
   * @return A content-less boundary response so a consumer can tell where the
   *   reasoning stopped, or nothing when no run was open or response metadata
   *   is switched off.
   */
  private closeReasoningStream(
    event: OpenAI.Responses.ResponseStreamEvent,
  ): LlmResponse[] {
    if (!this.reasoningOpen) {
      return [];
    }
    this.reasoningOpen = false;
    if (!this.includeResponseMetadata) {
      return [];
    }
    const streamEvent: ReasoningBoundary = {
      type: event.type,
      reasoning_done: true,
    };
    if ('output_index' in event) {
      streamEvent.output_index = event.output_index;
    }
    if ('item_id' in event) {
      streamEvent.item_id = event.item_id;
    }
    if ('summary_index' in event) {
      streamEvent.summary_index = event.summary_index;
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
}

/** Appends a delta to the fragment stored at an index. */
function appendIndexed(
  parts: Map<number, string>,
  index: number,
  delta: string,
): void {
  parts.set(index, (parts.get(index) ?? '') + delta);
}
