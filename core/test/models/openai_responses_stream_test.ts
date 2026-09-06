/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The stream accumulator on its own, without a model around it.
 *
 * `openai_responses_llm_test.ts` covers the streams the adk-python suite
 * builds; this file covers the event shapes it does not: reasoning text, the
 * done events, out-of-order items, and a stream that produces nothing.
 */

import {FinishReason} from '@google/genai';
import type {OpenAI} from 'openai';
import {describe, expect, it} from 'vitest';

import {LlmResponse} from '../../src/models/llm_response.js';
import {StreamAccumulator} from '../../src/models/openai_responses_stream.js';

import {
  argumentsDeltaEvent,
  argumentsDoneEvent,
  completedEvent,
  contentPartDoneEvent,
  createdEvent,
  functionCallItem,
  itemAddedEvent,
  itemDoneEvent,
  makeResponse,
  makeUsage,
  messageItem,
  reasoningItem,
  summaryDeltaEvent,
  textDeltaEvent,
  textDoneEvent,
} from './openai_responses_test_doubles.js';

/** Feeds every event to an accumulator and returns what it emitted. */
function run(
  events: OpenAI.Responses.ResponseStreamEvent[],
  includeResponseMetadata = true,
): {emitted: LlmResponse[]; accumulator: StreamAccumulator} {
  const accumulator = new StreamAccumulator({includeResponseMetadata});
  const emitted = events.flatMap((event) => accumulator.processEvent(event));
  return {emitted, accumulator};
}

describe('StreamAccumulator', () => {
  it('returns no final response for a stream that carried nothing', () => {
    const {emitted, accumulator} = run([]);

    expect(emitted).toEqual([]);
    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('ignores an event it has no handling for', () => {
    const {emitted, accumulator} = run([
      {
        type: 'response.in_progress',
        response: makeResponse({}),
        sequence_number: 0,
      },
    ]);

    expect(emitted).toEqual([]);
    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('assembles reasoning text deltas alongside the summary', () => {
    const {accumulator} = run([
      createdEvent(makeResponse({id: 'resp_1'})),
      itemAddedEvent(0, reasoningItem({})),
      summaryDeltaEvent(0, 'sum'),
      {
        type: 'response.reasoning_text.delta',
        delta: 'deep',
        content_index: 0,
        item_id: 'rs_0',
        output_index: 0,
        sequence_number: 0,
      },
      {
        type: 'response.reasoning_text.done',
        text: 'deeper',
        content_index: 0,
        item_id: 'rs_0',
        output_index: 0,
        sequence_number: 0,
      },
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'sumdeeper', thought: true},
    ]);
  });

  it('replaces the summary text with the one a summary part reports', () => {
    const {accumulator} = run([
      summaryDeltaEvent(0, 'partial'),
      {
        type: 'response.reasoning_summary_part.done',
        part: {type: 'summary_text', text: 'complete'},
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        sequence_number: 0,
      },
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'complete', thought: true},
    ]);
  });

  it('replaces streamed text with the text a done event reports', () => {
    const {accumulator} = run([
      textDeltaEvent(0, 'Hel'),
      textDoneEvent(0, 'Hello'),
      textDeltaEvent(1, 'By'),
      contentPartDoneEvent(1, 'Bye'),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'Hello'},
      {text: 'Bye'},
    ]);
  });

  it('keeps text arriving on separate content indices', () => {
    const {accumulator} = run([
      textDeltaEvent(0, 'second', 1),
      textDeltaEvent(0, 'first', 0),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'firstsecond'},
    ]);
  });

  it('keeps output items in the order the stream opened them', () => {
    const {accumulator} = run([
      textDeltaEvent(2, 'later'),
      textDeltaEvent(0, 'earlier'),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'later'},
      {text: 'earlier'},
    ]);
  });

  it('accepts a done event for an item it never saw opened', () => {
    const {accumulator} = run([
      itemDoneEvent(0, reasoningItem({encrypted_content: 'encrypted'})),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {thought: true, thoughtSignature: 'encrypted'},
    ]);
  });

  it('falls back to the accumulated text when a done item carries none', () => {
    const {accumulator} = run([
      textDeltaEvent(0, 'streamed'),
      itemDoneEvent(0, {...messageItem(''), content: []}),
      summaryDeltaEvent(1, 'thought'),
      itemDoneEvent(1, reasoningItem({id: 'rs_1', summary: []})),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'streamed'},
      {text: 'thought', thought: true},
    ]);
  });

  it('emits nothing for an item that streamed no text', () => {
    const {accumulator} = run([
      itemAddedEvent(0, reasoningItem({})),
      itemAddedEvent(1, {...messageItem(''), content: []}),
    ]);

    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('emits nothing for an item type it does not build parts for', () => {
    const {accumulator} = run([
      itemAddedEvent(0, {
        id: 'ws_1',
        type: 'web_search_call',
        status: 'completed',
        action: {type: 'search'},
      }),
    ]);

    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('reports a function call whose name only arrives with its arguments', () => {
    const {accumulator} = run([
      argumentsDeltaEvent(0, '{"city":'),
      argumentsDoneEvent(0, '{"city": "Paris"}', 'get_weather'),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {
        functionCall: {
          id: undefined,
          name: 'get_weather',
          args: {city: 'Paris'},
        },
      },
    ]);
  });

  it('keeps a streamed argument that the done item omits', () => {
    const {accumulator} = run([
      argumentsDeltaEvent(0, '{"city": "Paris"}'),
      itemDoneEvent(
        0,
        functionCallItem({call_id: '', id: 'fc_0', name: '', arguments: ''}),
      ),
    ]);

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {functionCall: {id: 'fc_0', name: '', args: {city: 'Paris'}}},
    ]);
  });

  it('suppresses the reasoning boundary when metadata is off', () => {
    const {emitted} = run(
      [summaryDeltaEvent(0, 'Think'), textDeltaEvent(1, 'Hello')],
      false,
    );

    expect(emitted.map((response) => response.customMetadata)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('closes an open reasoning stream at most once', () => {
    const {emitted} = run([
      summaryDeltaEvent(0, 'Think'),
      textDeltaEvent(1, 'a'),
      textDeltaEvent(1, 'b'),
    ]);

    expect(
      emitted.filter((response) => response.customMetadata !== undefined),
    ).toHaveLength(1);
  });

  it('does not close reasoning when the next item is itself reasoning', () => {
    const {emitted} = run([
      summaryDeltaEvent(0, 'Think'),
      itemAddedEvent(1, reasoningItem({id: 'rs_1'})),
    ]);

    expect(
      emitted.filter((response) => response.customMetadata !== undefined),
    ).toEqual([]);
  });

  it('carries the usage of a completed response into the final response', () => {
    const {accumulator} = run([
      createdEvent(makeResponse({id: 'resp_1'})),
      completedEvent(
        makeResponse({
          id: 'resp_1',
          status: 'completed',
          output: [messageItem('Hi')],
          usage: makeUsage({
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
          }),
        }),
      ),
    ]);

    expect(accumulator.finalResponse()?.usageMetadata?.totalTokenCount).toBe(3);
  });

  it('reports a stream error as a terminal response and no final response', () => {
    const {emitted, accumulator} = run([
      createdEvent(makeResponse({id: 'resp_1'})),
      textDeltaEvent(0, 'partial'),
      {
        type: 'error',
        code: 'server_error',
        message: 'boom',
        param: null,
        sequence_number: 0,
      },
    ]);

    const terminal = emitted[emitted.length - 1];
    expect(terminal.finishReason).toBe(FinishReason.OTHER);
    expect(terminal.errorCode).toBe(FinishReason.OTHER);
    expect(terminal.errorMessage).toContain('boom');
    expect(terminal.interactionId).toBe('resp_1');
    expect(accumulator.finalResponse()).toBeUndefined();
  });
});
