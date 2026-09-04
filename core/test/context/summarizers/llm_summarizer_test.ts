/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  LlmRequest,
  LlmResponse,
  LlmSummarizer,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockLlm extends BaseLlm {
  lastRequest: LlmRequest | undefined;

  constructor(private responses: LlmResponse[]) {
    super({model: 'mock-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    this.lastRequest = llmRequest;
    for (const response of this.responses) {
      if (response.errorCode) {
        throw new Error(response.errorMessage || 'LLM Error');
      }
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/** Runs the summarizer over `events` and returns the prompt the LLM saw. */
async function capturePrompt(
  events: Event[],
  prompt?: string,
): Promise<string> {
  const mockLlm = new MockLlm([
    {content: {role: 'model', parts: [{text: 'summary'}]}},
  ]);
  const summarizer = new LlmSummarizer({llm: mockLlm, prompt});
  await summarizer.summarize(events);

  const text = mockLlm.lastRequest?.contents?.[0]?.parts?.[0]?.text;
  if (text === undefined) {
    expect.fail('the summarizer sent no prompt to the LLM');
  }
  return text;
}

describe('LlmSummarizer', () => {
  it('should summarize events using the LLM and return a CompactedEvent', async () => {
    const mockLlm = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{text: 'This is the summarized '}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'content from the LLM.'}],
        },
      },
    ]);

    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
      createEvent({
        author: 'agent',
        timestamp: 2000,
        content: {role: 'model', parts: [{text: 'Hi there'}]},
      }),
    ];

    const compactedEvent = await summarizer.summarize(events);
    if (!compactedEvent) {
      expect.fail('summarize() declined to summarize the events');
    }

    expect(compactedEvent.isCompacted).toBe(true);
    expect(compactedEvent.startTime).toBe(1000);
    expect(compactedEvent.endTime).toBe(2000);
    expect(compactedEvent.author).toBe('user');
    expect(compactedEvent.content?.role).toBe('model');
    expect(compactedEvent.compactedContent).toBe(
      'This is the summarized content from the LLM.',
    );
    expect(compactedEvent.content?.parts?.[0]?.text).toBe(
      'This is the summarized content from the LLM.',
    );
    expect(compactedEvent.id).toBeDefined();
  });

  it('should return null if the LLM fails to return valid summary', async () => {
    const mockLlm = new MockLlm([
      {
        // empty content
        content: {
          role: 'model',
          parts: [],
        },
      },
    ]);

    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    await expect(summarizer.summarize(events)).resolves.toBeNull();
  });

  it('should return null when called with empty events list', async () => {
    const mockLlm = new MockLlm([]);
    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    await expect(summarizer.summarize([])).resolves.toBeNull();
  });

  it('should substitute the history at every placeholder in the prompt', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    const prompt = await capturePrompt(
      events,
      'BEFORE {conversation_history} AFTER {conversation_history} END',
    );

    expect(prompt).toBe('BEFORE user: Hello AFTER user: Hello END');
  });

  it('should append the history when the prompt has no placeholder', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    const prompt = await capturePrompt(events, 'Summarize this.');

    expect(prompt).toBe('Summarize this.\n\nuser: Hello');
  });

  it('should not expand dollar patterns in the substituted history', async () => {
    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: "cost $& and $` and $'"}]},
      }),
    ];

    const prompt = await capturePrompt(events, '[{conversation_history}]');

    expect(prompt).toBe("[user: cost $& and $` and $']");
  });

  it('should render tool parts that carry no args or response', async () => {
    const events: Event[] = [
      createEvent({
        author: 'model',
        timestamp: 1000,
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'tool'}},
            {functionResponse: {name: 'tool'}},
          ],
        },
      }),
    ];

    const prompt = await capturePrompt(events, '{conversation_history}');

    expect(prompt).toBe(
      'model called tool: tool({})\nTool response from tool: {}',
    );
  });

  it('should render nothing for a thought part that carries no text', async () => {
    const events: Event[] = [
      createEvent({
        author: 'model',
        timestamp: 1000,
        content: {
          role: 'model',
          parts: [{thought: true}, {text: 'Visible.'}],
        },
      }),
    ];

    const prompt = await capturePrompt(events, '{conversation_history}');

    expect(prompt).toBe('model: Visible.');
  });
});
