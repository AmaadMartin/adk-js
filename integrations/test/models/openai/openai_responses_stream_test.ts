/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmResponse} from '@google/adk';
import {FinishReason} from '@google/genai';
import type {
  Response,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import {describe, expect, it} from 'vitest';
import {StreamAccumulator} from '../../../src/models/openai/openai_responses_stream.js';
import {
  functionCallItem,
  makeResponse,
  outputMessage,
  outputText,
  reasoningItem,
} from './openai_response_fixtures.js';

/** Feeds every event to a fresh accumulator and collects what it yields. */
function run(
  events: ResponseStreamEvent[],
  includeResponseMetadata = true,
): {responses: LlmResponse[]; final?: LlmResponse} {
  const accumulator = new StreamAccumulator(includeResponseMetadata);
  const responses = events.flatMap((event) => accumulator.processEvent(event));
  return {responses, final: accumulator.finalResponse()};
}

const created = (response: Partial<Response> = {}): ResponseStreamEvent => ({
  type: 'response.created',
  sequence_number: 0,
  response: makeResponse(response),
});

const itemAdded = (
  outputIndex: number,
  item: ResponseOutputItem,
): ResponseStreamEvent => ({
  type: 'response.output_item.added',
  sequence_number: 0,
  output_index: outputIndex,
  item,
});

const itemDone = (
  outputIndex: number,
  item: ResponseOutputItem,
): ResponseStreamEvent => ({
  type: 'response.output_item.done',
  sequence_number: 0,
  output_index: outputIndex,
  item,
});

const textDelta = (
  outputIndex: number,
  contentIndex: number,
  delta: string,
): ResponseStreamEvent => ({
  type: 'response.output_text.delta',
  sequence_number: 0,
  output_index: outputIndex,
  content_index: contentIndex,
  item_id: 'msg_1',
  logprobs: [],
  delta,
});

const textDone = (
  outputIndex: number,
  contentIndex: number,
  text: string,
): ResponseStreamEvent => ({
  type: 'response.output_text.done',
  sequence_number: 0,
  output_index: outputIndex,
  content_index: contentIndex,
  item_id: 'msg_1',
  logprobs: [],
  text,
});

const contentPartDone = (
  outputIndex: number,
  part:
    | {type: 'output_text'; text: string; annotations: []}
    | {
        type: 'refusal';
        refusal: string;
      },
): ResponseStreamEvent => ({
  type: 'response.content_part.done',
  sequence_number: 0,
  output_index: outputIndex,
  content_index: 0,
  item_id: 'msg_1',
  part,
});

const summaryDelta = (
  outputIndex: number,
  summaryIndex: number,
  delta: string,
): ResponseStreamEvent => ({
  type: 'response.reasoning_summary_text.delta',
  sequence_number: 0,
  output_index: outputIndex,
  summary_index: summaryIndex,
  item_id: 'rs_1',
  delta,
});

const summaryDone = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
): ResponseStreamEvent => ({
  type: 'response.reasoning_summary_text.done',
  sequence_number: 0,
  output_index: outputIndex,
  summary_index: summaryIndex,
  item_id: 'rs_1',
  text,
});

const summaryPartDone = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
): ResponseStreamEvent => ({
  type: 'response.reasoning_summary_part.done',
  sequence_number: 0,
  output_index: outputIndex,
  summary_index: summaryIndex,
  item_id: 'rs_1',
  part: {type: 'summary_text', text},
});

const reasoningDelta = (
  outputIndex: number,
  delta: string,
): ResponseStreamEvent => ({
  type: 'response.reasoning_text.delta',
  sequence_number: 0,
  output_index: outputIndex,
  content_index: 0,
  item_id: 'rs_1',
  delta,
});

const reasoningDone = (
  outputIndex: number,
  text: string,
): ResponseStreamEvent => ({
  type: 'response.reasoning_text.done',
  sequence_number: 0,
  output_index: outputIndex,
  content_index: 0,
  item_id: 'rs_1',
  text,
});

const argsDelta = (
  outputIndex: number,
  delta: string,
): ResponseStreamEvent => ({
  type: 'response.function_call_arguments.delta',
  sequence_number: 0,
  output_index: outputIndex,
  item_id: 'fc_1',
  delta,
});

const argsDone = (
  outputIndex: number,
  args: string,
  name = 'get_weather',
): ResponseStreamEvent => ({
  type: 'response.function_call_arguments.done',
  sequence_number: 0,
  output_index: outputIndex,
  item_id: 'fc_1',
  name,
  arguments: args,
});

describe('StreamAccumulator', () => {
  it('yields a partial for each text delta and assembles the final text', () => {
    const {responses, final} = run([
      created({id: 'resp_1', model: 'gpt-5'}),
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'Hel'),
      textDelta(0, 0, 'lo'),
    ]);

    expect(responses.map((r) => r.content?.parts?.[0].text)).toEqual([
      'Hel',
      'lo',
    ]);
    expect(responses.every((r) => r.partial)).toBe(true);
    expect(responses[0].interactionId).toBe('resp_1');
    expect(responses[0].modelVersion).toBe('gpt-5');
    expect(final?.content?.parts).toEqual([{text: 'Hello'}]);
    expect(final?.finishReason).toBe(FinishReason.STOP);
    expect(final?.partial).toBe(false);
  });

  it('marks the boundary where streamed reasoning ends', () => {
    const {responses} = run([
      created(),
      summaryDelta(0, 0, 'Think'),
      textDelta(1, 0, 'Hello'),
    ]);

    expect(responses[0].content?.parts).toEqual([
      {text: 'Think', thought: true},
    ]);
    expect(responses[1].content).toBeUndefined();
    expect(responses[1].customMetadata).toEqual({
      openai_response: {
        stream_event: {
          type: 'response.output_text.delta',
          reasoning_done: true,
          output_index: 1,
          item_id: 'msg_1',
        },
      },
    });
    expect(responses[2].content?.parts).toEqual([{text: 'Hello'}]);
  });

  it('omits the boundary marker when metadata is switched off', () => {
    const {responses} = run(
      [created(), summaryDelta(0, 0, 'Think'), textDelta(1, 0, 'Hello')],
      false,
    );

    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.customMetadata)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('marks the boundary once, on the first event that follows reasoning', () => {
    const {responses} = run([
      created(),
      summaryDelta(0, 0, 'Think'),
      textDelta(1, 0, 'a'),
      textDelta(1, 0, 'b'),
    ]);

    const boundaries = responses.filter((r) => r.customMetadata);
    expect(boundaries).toHaveLength(1);
  });

  it('carries the summary index onto the boundary marker', () => {
    const {responses} = run([
      created(),
      summaryDelta(0, 0, 'Think'),
      summaryDone(0, 0, 'Think'),
    ]);

    expect(responses[1].customMetadata).toEqual({
      openai_response: {
        stream_event: {
          type: 'response.reasoning_summary_text.done',
          reasoning_done: true,
          output_index: 0,
          item_id: 'rs_1',
          summary_index: 0,
        },
      },
    });
  });

  it('keeps interleaved reasoning and message items apart in the fallback', () => {
    const {final} = run([
      created(),
      itemAdded(0, reasoningItem()),
      summaryDelta(0, 0, 'Think'),
      summaryDone(0, 0, 'Think'),
      itemAdded(1, outputMessage([])),
      textDelta(1, 0, 'Hel'),
      textDelta(1, 0, 'lo'),
      itemAdded(2, reasoningItem({id: 'rs_2'})),
      summaryDelta(2, 0, 'Again'),
      itemAdded(3, outputMessage([])),
      textDelta(3, 0, 'Bye'),
    ]);

    expect(final?.content?.parts).toEqual([
      {text: 'Think', thought: true},
      {text: 'Hello'},
      {text: 'Again', thought: true},
      {text: 'Bye'},
    ]);
  });

  it('reports both boundary event types across an interleaved stream', () => {
    const {responses} = run([
      created(),
      itemAdded(0, reasoningItem()),
      summaryDelta(0, 0, 'Think'),
      summaryDone(0, 0, 'Think'),
      itemAdded(1, outputMessage([])),
      summaryDelta(1, 0, 'Again'),
      itemAdded(2, outputMessage([])),
    ]);

    const boundaryTypes = responses
      .filter((r) => r.customMetadata)
      .map(
        (r) =>
          (
            r.customMetadata?.['openai_response'] as {
              stream_event: {type: string};
            }
          ).stream_event.type,
      );
    expect(boundaryTypes).toEqual([
      'response.reasoning_summary_text.done',
      'response.output_item.added',
    ]);
  });

  it('joins indexed text fragments in index order', () => {
    const {final} = run([
      created(),
      itemAdded(0, outputMessage([])),
      textDelta(0, 1, 'second'),
      textDelta(0, 0, 'first '),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'first second'}]);
  });

  it('lets a done event replace the fragment it finishes', () => {
    const {final} = run([
      created(),
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'par'),
      textDone(0, 0, 'partial text'),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'partial text'}]);
  });

  it('takes the finished text from a content part when the event has none', () => {
    const {final} = run([
      created(),
      itemAdded(0, outputMessage([])),
      contentPartDone(0, {
        type: 'output_text',
        text: 'from part',
        annotations: [],
      }),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'from part'}]);
  });

  it('ignores a content part that carries no text', () => {
    const {final} = run([
      created(),
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'kept'),
      contentPartDone(0, {type: 'refusal', refusal: 'no'}),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'kept'}]);
  });

  it('accumulates unindexed reasoning text and lets its done event replace it', () => {
    const withDelta = run([
      created(),
      itemAdded(0, reasoningItem()),
      reasoningDelta(0, 'Th'),
      reasoningDelta(0, 'ink'),
    ]);
    expect(withDelta.final?.content?.parts).toEqual([
      {text: 'Think', thought: true},
    ]);

    const withDone = run([
      created(),
      itemAdded(0, reasoningItem()),
      reasoningDelta(0, 'Th'),
      reasoningDone(0, 'Thought'),
    ]);
    expect(withDone.final?.content?.parts).toEqual([
      {text: 'Thought', thought: true},
    ]);
  });

  it('takes the finished reasoning text from a summary part event', () => {
    const {final} = run([
      created(),
      itemAdded(0, reasoningItem()),
      summaryDelta(0, 0, 'Th'),
      summaryPartDone(0, 0, 'Thought'),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'Thought', thought: true}]);
  });

  it('ignores a reasoning done event that carries no text', () => {
    const {final} = run([
      created(),
      itemAdded(0, reasoningItem()),
      summaryDelta(0, 0, 'Think'),
      summaryDone(0, 0, ''),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'Think', thought: true}]);
  });

  it('assembles a function call from its argument deltas', () => {
    const {responses, final} = run([
      itemAdded(0, functionCallItem()),
      argsDelta(0, '{"city"'),
      argsDelta(0, ': "SF"}'),
    ]);

    expect(responses).toEqual([]);
    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'SF'}}},
    ]);
    expect(final?.finishReason).toBe(FinishReason.STOP);
  });

  it('lets the arguments done event replace the streamed arguments', () => {
    const {final} = run([
      itemAdded(0, functionCallItem()),
      argsDelta(0, '{"city": "wrong"}'),
      argsDone(0, '{"city": "SF"}'),
    ]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'SF'}}},
    ]);
  });

  it('names a function call from the arguments done event alone', () => {
    const {final} = run([argsDone(0, '{}', 'lookup')]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: undefined, name: 'lookup', args: {}}},
    ]);
  });

  it('keeps the streamed fields a done item leaves out', () => {
    const {final} = run([
      itemAdded(0, functionCallItem()),
      argsDelta(0, '{"city": "SF"}'),
      itemDone(0, functionCallItem({name: '', call_id: '', arguments: ''})),
    ]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'SF'}}},
    ]);
  });

  it('falls back to the item id when a call carries no call id', () => {
    const {final} = run([
      itemAdded(0, functionCallItem({call_id: '', id: 'fc_1'})),
      argsDelta(0, '{}'),
    ]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'fc_1', name: 'get_weather', args: {}}},
    ]);
  });

  it('keeps the accumulated call id when a done item carries none', () => {
    const {final} = run([
      itemAdded(0, functionCallItem({call_id: 'call_1'})),
      argsDelta(0, '{}'),
      itemDone(0, functionCallItem({call_id: '', id: '', name: ''})),
    ]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'call_1', name: 'get_weather', args: {}}},
    ]);
  });

  it('still emits a call the stream never named', () => {
    const {final} = run([
      itemAdded(0, functionCallItem({name: '', call_id: 'call_1'})),
      argsDelta(0, '{}'),
    ]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'call_1', name: '', args: {}}},
    ]);
  });

  it('keeps the accumulated name when a done item carries none', () => {
    const {final} = run([
      argsDone(0, '{"city": "SF"}', 'lookup'),
      itemDone(0, functionCallItem({name: '', call_id: 'call_9'})),
    ]);

    expect(final?.content?.parts).toEqual([
      {functionCall: {id: 'call_9', name: 'lookup', args: {city: 'SF'}}},
    ]);
  });

  it('yields nothing for a reasoning item that never produced text', () => {
    const {final} = run([created(), itemAdded(0, reasoningItem())]);

    expect(final).toBeUndefined();
  });

  it('yields nothing for a message item that never produced text', () => {
    const {final} = run([created(), itemAdded(0, outputMessage([]))]);

    expect(final).toBeUndefined();
  });

  it('prefers the text of a done output item over the streamed text', () => {
    const {final} = run([
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'streamed'),
      itemDone(0, outputMessage([outputText('Done text')])),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'Done text'}]);
  });

  it('falls back to the streamed text when the done item has none', () => {
    const {final} = run([
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'streamed'),
      itemDone(0, outputMessage([])),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'streamed'}]);
  });

  it('prefers a done reasoning item over the streamed reasoning', () => {
    const {final} = run([
      itemAdded(0, reasoningItem()),
      summaryDelta(0, 0, 'streamed'),
      itemDone(
        0,
        reasoningItem({summary: [{type: 'summary_text', text: 'Done think'}]}),
      ),
    ]);

    expect(final?.content?.parts).toEqual([
      {text: 'Done think', thought: true, thoughtSignature: undefined},
    ]);
  });

  it('falls back to the streamed reasoning when the done item has none', () => {
    const {final} = run([
      itemAdded(0, reasoningItem()),
      summaryDelta(0, 0, 'streamed'),
      itemDone(0, reasoningItem()),
    ]);

    expect(final?.content?.parts).toEqual([{text: 'streamed', thought: true}]);
  });

  it('converts the completed response instead of assembling a fallback', () => {
    const {final} = run([
      created(),
      textDelta(0, 0, 'ignored'),
      {
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponse({
          status: 'completed',
          output: [outputMessage([outputText('Authoritative')])],
        }),
      },
    ]);

    expect(final?.content?.parts).toEqual([{text: 'Authoritative'}]);
  });

  it('reports a streamed cutoff as MAX_TOKENS', () => {
    const {final} = run([
      created(),
      textDelta(0, 0, 'Hi'),
      {
        type: 'response.incomplete',
        sequence_number: 0,
        response: makeResponse({
          status: 'incomplete',
          incomplete_details: {reason: 'max_output_tokens'},
          output: [outputMessage([outputText('Hi')])],
        }),
      },
    ]);

    expect(final?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('carries the usage the completed response reported', () => {
    const {final} = run([
      created(),
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'Hi'),
      {
        type: 'response.incomplete',
        sequence_number: 0,
        response: makeResponse({
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            total_tokens: 3,
            input_tokens_details: {cached_tokens: 0, cache_write_tokens: 0},
            output_tokens_details: {reasoning_tokens: 0},
          },
        }),
      },
    ]);

    expect(final?.usageMetadata).toMatchObject({totalTokenCount: 3});
  });

  it('treats a failed event as terminal', () => {
    const {responses, final} = run([
      created(),
      itemAdded(0, outputMessage([])),
      textDelta(0, 0, 'partial'),
      {
        type: 'response.failed',
        sequence_number: 0,
        response: makeResponse({status: 'failed'}),
      },
    ]);

    expect(responses).toHaveLength(2);
    expect(responses[1].finishReason).toBe(FinishReason.OTHER);
    expect(responses[1].errorCode).toBe(FinishReason.OTHER);
    expect(responses[1].errorMessage).toContain('response.failed');
    expect(final).toBeUndefined();
  });

  it('treats a transport error event as terminal', () => {
    const {responses, final} = run([
      created(),
      {
        type: 'error',
        sequence_number: 0,
        code: 'server_error',
        message: 'boom',
        param: null,
      },
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0].errorMessage).toContain('boom');
    expect(final).toBeUndefined();
  });

  it('returns no final response when the stream produced nothing', () => {
    expect(run([created()]).final).toBeUndefined();
  });

  it('ignores an event it does not map', () => {
    const {responses, final} = run([
      created(),
      {
        type: 'response.in_progress',
        sequence_number: 0,
        response: makeResponse(),
      },
    ]);

    expect(responses).toEqual([]);
    expect(final).toBeUndefined();
  });

  it('yields nothing for an output item it cannot turn into parts', () => {
    const {final} = run([
      itemAdded(0, {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: {type: 'search'},
      }),
    ]);

    expect(final).toBeUndefined();
  });
});
