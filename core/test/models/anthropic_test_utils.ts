/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentBlock,
  Message,
  RawContentBlockDelta,
  RawContentBlockStartEvent,
  RawMessageStreamEvent,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';

/** Builds an Anthropic `Usage` with the two counts ADK reads. */
export function anthropicUsage(
  inputTokens: number,
  outputTokens: number,
): Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

/** Builds a complete Anthropic response message. */
export function anthropicMessage(
  content: ContentBlock[],
  usage: Usage = anthropicUsage(0, 0),
): Message {
  return {
    id: 'msg_test',
    container: null,
    content,
    model: 'claude-sonnet-4-20250514',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage,
  };
}

/** Builds the `message_start` event that opens a stream. */
export function messageStartEvent(
  inputTokens: number,
  outputTokens = 0,
): RawMessageStreamEvent {
  return {
    type: 'message_start',
    message: anthropicMessage([], anthropicUsage(inputTokens, outputTokens)),
  };
}

/** Builds a `content_block_start` event for the given block index. */
export function blockStartEvent(
  index: number,
  contentBlock: RawContentBlockStartEvent['content_block'],
): RawMessageStreamEvent {
  return {type: 'content_block_start', index, content_block: contentBlock};
}

/** Builds a `content_block_delta` event for the given block index. */
export function blockDeltaEvent(
  index: number,
  delta: RawContentBlockDelta,
): RawMessageStreamEvent {
  return {type: 'content_block_delta', index, delta};
}

/** Builds a `content_block_stop` event for the given block index. */
export function blockStopEvent(index: number): RawMessageStreamEvent {
  return {type: 'content_block_stop', index};
}

/** Builds the `message_delta` event carrying the final output token count. */
export function messageDeltaEvent(outputTokens: number): RawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: {
      container: null,
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: null,
      output_tokens: outputTokens,
      output_tokens_details: null,
      server_tool_use: null,
    },
  };
}

/** Builds the `message_stop` event that closes a stream. */
export function messageStopEvent(): RawMessageStreamEvent {
  return {type: 'message_stop'};
}

/** Wraps stream events in the async iterable the Anthropic SDK returns. */
export async function* asStream(
  events: RawMessageStreamEvent[],
): AsyncGenerator<RawMessageStreamEvent, void> {
  for (const event of events) {
    yield event;
  }
}
