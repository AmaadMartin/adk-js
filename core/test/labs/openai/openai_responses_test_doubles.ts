/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test doubles for the OpenAI Responses models.
 *
 * Mirrors `_CaptureClient` / `_CaptureResponses` / `_FakeAsyncStream` in
 * `tests/unittests/labs/openai/test_openai_responses_llm.py` in
 * google/adk-python.
 */

import {LlmRequest} from '@google/adk';

import {OpenAIStreamEvent} from '../../../src/labs/openai/openai_responses_converters.js';
import {
  OpenAIRequestOptions,
  OpenAIResponsesClient,
  OpenAIResponsesResource,
} from '../../../src/labs/openai/openai_responses_llm.js';

/** A `responses` resource that records the body and returns a canned result. */
export class CaptureResponses implements OpenAIResponsesResource {
  /** The body of the most recent `create` call. */
  body?: Record<string, unknown>;
  /** The options of the most recent `create` call. */
  options?: OpenAIRequestOptions;
  /** How many times `create` was called. */
  createCalls = 0;

  constructor(private readonly result: unknown) {}

  async create(
    body: Record<string, unknown>,
    options?: OpenAIRequestOptions,
  ): Promise<unknown> {
    this.body = body;
    this.options = options;
    this.createCalls += 1;
    return this.result;
  }
}

/** A client that satisfies {@link OpenAIResponsesClient} structurally. */
export class CaptureClient implements OpenAIResponsesClient {
  readonly responses: CaptureResponses;

  constructor(result: unknown) {
    this.responses = new CaptureResponses(result);
  }
}

/** Replays a fixed list of events as the stream a client would return. */
export async function* fakeEventStream(
  events: OpenAIStreamEvent[],
): AsyncGenerator<OpenAIStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

/** Builds an `LlmRequest` with the fields the models read. */
export function llmRequestOf(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}, ...overrides};
}

/** Builds a one-turn user request, optionally with a generation config. */
export function userRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return llmRequestOf({
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    ...overrides,
  });
}

/** Drains an async generator into an array. */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}
