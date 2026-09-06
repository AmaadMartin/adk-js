/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Accumulation of an OpenAI Responses API event stream.
 *
 * Ported from `_StreamAccumulator` in adk-python
 * `src/google/adk/labs/openai/_openai_responses_llm.py`.
 */

import {FinishReason, Part} from '@google/genai';
import type {OpenAI} from 'openai';

import {LlmResponse} from './llm_response.js';
import {
  loadsJsonObject,
  messageContentParts,
  reasoningParts,
  responseToLlmResponse,
  toUsageMetadata,
} from './openai_responses_converters.js';

/** One output item of the response, assembled from the events about it. */
interface AccumulatedItem {
  /** The item type the stream reported, when it reported one. */
  type?: string;
  /** The completed item, when `response.output_item.done` carried one. */
  doneItem?: OpenAI.Responses.ResponseOutputItem;
  /** Message text, by content index. */
  text: Map<number, string>;
  /** Reasoning summary text, by summary index. */
  summary: Map<number, string>;
  /** Reasoning text, by content index. */
  reasoning: Map<number, string>;
}

/** One function call of the response, assembled from the events about it. */
interface AccumulatedCall {
  name: string;
  callId?: string;
  arguments: string;
}

/** The stream-event fields recorded when a reasoning stream closes. */
interface ReasoningBoundary {
  type: string;
  reasoning_done: true;
  output_index?: number;
  item_id?: string;
  summary_index?: number;
}

/** Appends `text` to the entry at `index`. */
function appendIndexed(
  target: Map<number, string>,
  index: number,
  text: string,
): void {
  target.set(index, (target.get(index) ?? '') + text);
}

/** Joins the indexed entries in index order. */
function assemble(...sources: Array<Map<number, string>>): string {
  return sources
    .flatMap((source) => [...source.entries()].sort((a, b) => a[0] - b[0]))
    .map(([, text]) => text)
    .join('');
}

/** Records the fields of the event that closed a reasoning stream. */
function reasoningBoundary(
  event: OpenAI.Responses.ResponseStreamEvent,
): ReasoningBoundary {
  const boundary: ReasoningBoundary = {type: event.type, reasoning_done: true};
  if ('output_index' in event) {
    boundary.output_index = event.output_index;
  }
  if ('item_id' in event) {
    boundary.item_id = event.item_id;
  }
  if ('summary_index' in event) {
    boundary.summary_index = event.summary_index;
  }
  return boundary;
}

/** Converts an accumulated function call into an ADK part. */
function callToPart(call: AccumulatedCall): Part {
  return {
    functionCall: {
      id: call.callId,
      name: call.name,
      args: loadsJsonObject(call.arguments),
    },
  };
}

/**
 * Turns a Responses event stream into ADK responses.
 *
 * One instance covers one call: it holds the partial state of a single
 * response and must not be shared between concurrent calls. Its memory is
 * bounded by the size of that one response, so it needs no eviction policy.
 *
 * Feed every event to {@link processEvent}, yielding whatever it returns, then
 * yield {@link finalResponse} once the stream ends.
 */
export class StreamAccumulator {
  private readonly includeResponseMetadata: boolean;
  private readonly outputItems = new Map<number, AccumulatedItem>();
  private readonly functionCalls = new Map<number, AccumulatedCall>();
  private response?: OpenAI.Responses.Response;
  private usage?: OpenAI.Responses.ResponseUsage;
  private model?: string;
  private responseId?: string;
  private failed = false;
  private reasoningOpen = false;

  constructor({includeResponseMetadata}: {includeResponseMetadata: boolean}) {
    this.includeResponseMetadata = includeResponseMetadata;
  }

  /**
   * Folds one stream event into the accumulated response.
   *
   * @param event The event the API sent.
   * @return The responses to yield for it: text and thought deltas as they
   *   arrive, a boundary marker when a reasoning stream closes, and a terminal
   *   error response when the stream fails.
   */
  processEvent(event: OpenAI.Responses.ResponseStreamEvent): LlmResponse[] {
    switch (event.type) {
      case 'response.created':
        this.responseId = event.response.id;
        this.model = event.response.model;
        return [];

      case 'response.output_text.delta': {
        const closed = this.closeReasoning(event);
        const item = this.itemAt(event.output_index, 'message');
        appendIndexed(item.text, event.content_index, event.delta);
        return [...closed, this.partial([{text: event.delta}])];
      }

      case 'response.reasoning_summary_text.delta': {
        this.reasoningOpen = true;
        const item = this.itemAt(event.output_index, 'reasoning');
        appendIndexed(item.summary, event.summary_index, event.delta);
        return [this.partial([{text: event.delta, thought: true}])];
      }

      case 'response.reasoning_text.delta': {
        this.reasoningOpen = true;
        const item = this.itemAt(event.output_index, 'reasoning');
        appendIndexed(item.reasoning, event.content_index, event.delta);
        return [this.partial([{text: event.delta, thought: true}])];
      }

      case 'response.output_item.added':
      case 'response.output_item.done': {
        const closed =
          event.item.type === 'reasoning' ? [] : this.closeReasoning(event);
        const item = this.itemAt(event.output_index, event.item.type);
        if (event.type === 'response.output_item.done') {
          item.doneItem = event.item;
        }
        if (event.item.type === 'function_call') {
          this.trackFunctionCall(event.output_index, event.item);
        }
        return closed;
      }

      case 'response.content_part.done': {
        const closed = this.closeReasoning(event);
        const item = this.itemAt(event.output_index, 'message');
        if (event.part.type === 'output_text' && event.part.text) {
          item.text.set(event.content_index, event.part.text);
        }
        return closed;
      }

      case 'response.output_text.done': {
        const closed = this.closeReasoning(event);
        const item = this.itemAt(event.output_index, 'message');
        if (event.text) {
          item.text.set(event.content_index, event.text);
        }
        return closed;
      }

      case 'response.reasoning_summary_text.done': {
        const item = this.itemAt(event.output_index, 'reasoning');
        if (event.text) {
          item.summary.set(event.summary_index, event.text);
        }
        return this.closeReasoning(event);
      }

      case 'response.reasoning_summary_part.done': {
        const item = this.itemAt(event.output_index, 'reasoning');
        if (event.part.text) {
          item.summary.set(event.summary_index, event.part.text);
        }
        return this.closeReasoning(event);
      }

      case 'response.reasoning_text.done': {
        const item = this.itemAt(event.output_index, 'reasoning');
        if (event.text) {
          item.reasoning.set(event.content_index, event.text);
        }
        return this.closeReasoning(event);
      }

      case 'response.function_call_arguments.delta': {
        const closed = this.closeReasoning(event);
        this.itemAt(event.output_index, 'function_call');
        this.callAt(event.output_index).arguments += event.delta;
        return closed;
      }

      case 'response.function_call_arguments.done': {
        const closed = this.closeReasoning(event);
        this.itemAt(event.output_index, 'function_call');
        const call = this.callAt(event.output_index);
        call.arguments = event.arguments;
        call.name ||= event.name;
        return closed;
      }

      case 'response.completed':
      case 'response.incomplete':
        this.response = event.response;
        this.usage = event.response.usage ?? this.usage;
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
   * @return The converted response when the API sent a terminal one, a
   *   response assembled from the accumulated items when it did not, and
   *   `undefined` when the stream failed or produced nothing.
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

    const parts = this.accumulatedParts();
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

  /**
   * Builds the parts of a response the API never sent in full.
   *
   * Every function call is reached through its output item, because both are
   * keyed by the `output_index` that each item-scoped event carries.
   */
  private accumulatedParts(): Part[] {
    const parts: Part[] = [];
    for (const [index, item] of this.outputItems) {
      parts.push(...this.itemParts(index, item));
    }
    return parts;
  }

  /** Builds the parts of one accumulated output item. */
  private itemParts(index: number, item: AccumulatedItem): Part[] {
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

    switch (doneItem?.type ?? item.type) {
      case 'reasoning': {
        const text = assemble(item.summary, item.reasoning);
        return text ? [{text, thought: true}] : [];
      }
      case 'message': {
        const text = assemble(item.text);
        return text ? [{text}] : [];
      }
      case 'function_call': {
        const call = this.functionCalls.get(index);
        return call ? [callToPart(call)] : [];
      }
      default:
        return [];
    }
  }

  /**
   * Ends an open reasoning stream.
   *
   * The boundary is reported so a caller streaming thoughts can tell where one
   * reasoning item stopped, which the text deltas alone do not say.
   */
  private closeReasoning(
    event: OpenAI.Responses.ResponseStreamEvent,
  ): LlmResponse[] {
    if (!this.reasoningOpen) {
      return [];
    }
    this.reasoningOpen = false;
    if (!this.includeResponseMetadata) {
      return [];
    }
    return [
      {
        partial: true,
        modelVersion: this.model,
        interactionId: this.responseId,
        customMetadata: {
          openai_response: {stream_event: reasoningBoundary(event)},
        },
      },
    ];
  }

  /** Returns the item at `index`, creating it on first mention. */
  private itemAt(index: number, type?: string): AccumulatedItem {
    let item = this.outputItems.get(index);
    if (!item) {
      item = {
        text: new Map<number, string>(),
        summary: new Map<number, string>(),
        reasoning: new Map<number, string>(),
      };
      this.outputItems.set(index, item);
    }
    item.type ??= type;
    return item;
  }

  /** Returns the function call at `index`, creating it on first mention. */
  private callAt(index: number): AccumulatedCall {
    let call = this.functionCalls.get(index);
    if (!call) {
      call = {name: '', arguments: ''};
      this.functionCalls.set(index, call);
    }
    return call;
  }

  /**
   * Records a function call reported as a whole item.
   *
   * A done item can omit fields already streamed as deltas, so what is already
   * accumulated wins over an empty field.
   */
  private trackFunctionCall(
    index: number,
    item: OpenAI.Responses.ResponseFunctionToolCall,
  ): void {
    const call = this.callAt(index);
    call.name = item.name || call.name;
    call.callId = item.call_id || item.id || call.callId;
    call.arguments = item.arguments || call.arguments;
  }

  /** Builds a partial response carrying the parts of one delta. */
  private partial(parts: Part[]): LlmResponse {
    return {
      content: {role: 'model', parts},
      partial: true,
      modelVersion: this.model,
      interactionId: this.responseId,
    };
  }
}
