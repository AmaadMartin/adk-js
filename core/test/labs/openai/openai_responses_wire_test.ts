/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// What a real `openai` client actually puts on the wire.
//
// Every other test in this directory injects a client double, which stands in
// for the SDK's serialization step and so cannot see the request the API
// receives. These tests drive a real `OpenAI` instance whose `fetch` is
// replaced, so the assertions are against the JSON body itself. No network
// call is made: the injected `fetch` never leaves the process.

import {OpenAI} from 'openai';
import {beforeEach, describe, expect, it} from 'vitest';

import {OpenAIResponsesLlm} from '../../../src/labs/openai/openai_responses_llm.js';

import {collect, userRequest} from './openai_responses_test_doubles.js';

/** A completed response with no output, enough for the client to parse. */
const CANNED_RESPONSE = {
  id: 'resp_wire',
  model: 'gpt-5',
  status: 'completed',
  output: [],
};

/** The part of a request init the recorder reads. */
interface RecordedRequestInit {
  body?: unknown;
}

/** Records the JSON body of each request instead of sending it. */
class FetchRecorder {
  /** The parsed body of the most recent request. */
  body?: Record<string, unknown>;

  readonly fetch = async (
    _input: string | URL | Request,
    init?: RecordedRequestInit,
  ): Promise<Response> => {
    this.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(CANNED_RESPONSE), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
}

let recorder: FetchRecorder;

/** Builds a model backed by a real client that records instead of sending. */
function recordingLlm(
  extraRequestArgs?: Record<string, unknown>,
): OpenAIResponsesLlm {
  return new OpenAIResponsesLlm({
    model: 'gpt-5',
    extraRequestArgs,
    client: new OpenAI({apiKey: 'test-key', fetch: recorder.fetch}),
  });
}

beforeEach(() => {
  recorder = new FetchRecorder();
});

describe('OpenAI Responses request body on the wire', () => {
  it('sends the stop sequences as a top-level field', async () => {
    const llm = recordingLlm();

    await collect(
      llm.generateContentAsync(
        userRequest({config: {stopSequences: ['STOP']}}),
      ),
    );

    expect(recorder.body?.['stop']).toEqual(['STOP']);
    expect(recorder.body).not.toHaveProperty('extra_body');
  });

  it('flattens extraRequestArgs.extra_body into the body', async () => {
    const llm = recordingLlm({extra_body: {foo: 'bar'}});

    await collect(llm.generateContentAsync(userRequest()));

    expect(recorder.body?.['foo']).toBe('bar');
    expect(recorder.body).not.toHaveProperty('extra_body');
  });

  it('lets extraRequestArgs override a computed field', async () => {
    const llm = recordingLlm({temperature: 0.9});

    await collect(
      llm.generateContentAsync(userRequest({config: {temperature: 0.1}})),
    );

    expect(recorder.body?.['temperature']).toBe(0.9);
  });

  it('lets an extra_body entry override a computed field', async () => {
    const llm = recordingLlm({extra_body: {stop: ['FROM_EXTRA_BODY']}});

    await collect(
      llm.generateContentAsync(
        userRequest({config: {stopSequences: ['STOP']}}),
      ),
    );

    expect(recorder.body?.['stop']).toEqual(['FROM_EXTRA_BODY']);
  });

  it('sends the whole request shape the Responses API expects', async () => {
    const llm = recordingLlm({extra_body: {foo: 'bar'}});

    await collect(
      llm.generateContentAsync(
        userRequest({
          config: {
            systemInstruction: 'Be brief.',
            temperature: 0.2,
            maxOutputTokens: 128,
            stopSequences: ['STOP'],
          },
        }),
      ),
    );

    expect(recorder.body).toEqual({
      model: 'gpt-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'Hi'}],
        },
      ],
      stream: false,
      instructions: 'Be brief.',
      temperature: 0.2,
      max_output_tokens: 128,
      stop: ['STOP'],
      foo: 'bar',
    });
  });

  it('reads a response the real client parsed', async () => {
    const llm = recordingLlm();

    const responses = await collect(llm.generateContentAsync(userRequest()));

    expect(responses).toHaveLength(1);
    expect(responses[0]?.interactionId).toBe('resp_wire');
    expect(responses[0]?.modelVersion).toBe('gpt-5');
  });
});
