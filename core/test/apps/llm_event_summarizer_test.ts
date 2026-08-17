/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  LlmEventSummarizer,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_SUMMARIZER_PROMPT_TEMPLATE,
  formatEventsForPrompt,
  truncate,
} from '../../src/apps/llm_event_summarizer.js';

class FakeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  readonly streamFlags: Array<boolean | undefined> = [];

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'test-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    this.streamFlags.push(stream);
    for (const response of this.responses) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not supported by FakeLlm');
  }
}

function textEvent(timestamp: number, text: string, author: string): Event {
  return createEvent({
    timestamp,
    author,
    content: {parts: [{text}]},
  });
}

function expectedPrompt(history: string): string {
  return DEFAULT_SUMMARIZER_PROMPT_TEMPLATE.replace(
    '{conversation_history}',
    () => history,
  );
}

describe('LlmEventSummarizer.maybeSummarizeEvents', () => {
  it('returns an event carrying the summary and the compacted range', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'Summary'}]}}]);
    const summarizer = new LlmEventSummarizer({llm});

    const event = await summarizer.maybeSummarizeEvents([
      textEvent(1000, 'Hello', 'user'),
      textEvent(2000, 'Hi there!', 'model'),
    ]);

    expect(event).toBeDefined();
    expect(event?.author).toBe('user');
    expect(event?.invocationId).toBeTruthy();
    const compaction = event?.actions.compaction;
    expect(compaction?.startTimestamp).toBe(1000);
    expect(compaction?.endTimestamp).toBe(2000);
    expect(compaction?.compactedContent.role).toBe('model');
    expect(compaction?.compactedContent.parts?.[0]?.text).toBe('Summary');
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].model).toBe('test-model');
    expect(llm.requests[0].contents[0].role).toBe('user');
    expect(llm.requests[0].contents[0].parts?.[0]?.text).toBe(
      expectedPrompt('user: Hello\nmodel: Hi there!'),
    );
    expect(llm.streamFlags).toEqual([false]);
  });

  it('returns undefined when the model produces no content', async () => {
    const llm = new FakeLlm([{}]);
    const summarizer = new LlmEventSummarizer({llm});

    const event = await summarizer.maybeSummarizeEvents([
      textEvent(1000, 'Hello', 'user'),
    ]);

    expect(event).toBeUndefined();
  });

  it('skips content-less responses and uses the first one with content', async () => {
    const llm = new FakeLlm([{}, {content: {parts: [{text: 'Summary'}]}}]);
    const summarizer = new LlmEventSummarizer({llm});

    const event = await summarizer.maybeSummarizeEvents([
      textEvent(1000, 'Hello', 'user'),
    ]);

    expect(event?.actions.compaction?.compactedContent.parts?.[0]?.text).toBe(
      'Summary',
    );
  });

  it('propagates usage metadata onto the returned event', async () => {
    const usageMetadata = {promptTokenCount: 10, candidatesTokenCount: 5};
    const llm = new FakeLlm([
      {content: {parts: [{text: 'Summary'}]}, usageMetadata},
    ]);
    const summarizer = new LlmEventSummarizer({llm});

    const event = await summarizer.maybeSummarizeEvents([
      textEvent(1000, 'Hello', 'user'),
      textEvent(2000, 'Hi there!', 'model'),
    ]);

    expect(event?.usageMetadata).toEqual(usageMetadata);
  });

  it('returns undefined for an empty window without calling the model', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'Summary'}]}}]);
    const summarizer = new LlmEventSummarizer({llm});

    expect(await summarizer.maybeSummarizeEvents([])).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
  });

  it('uses a custom prompt template', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'Summary'}]}}]);
    const summarizer = new LlmEventSummarizer({
      llm,
      promptTemplate: 'Recap:\n{conversation_history}',
    });

    await summarizer.maybeSummarizeEvents([textEvent(1000, 'Hello', 'user')]);

    expect(llm.requests[0].contents[0].parts?.[0]?.text).toBe(
      'Recap:\nuser: Hello',
    );
  });

  it('does not expand $ replacement patterns from the conversation', async () => {
    const llm = new FakeLlm([{content: {parts: [{text: 'Summary'}]}}]);
    const summarizer = new LlmEventSummarizer({llm});

    await summarizer.maybeSummarizeEvents([
      textEvent(1000, "price is $& and $' and $`", 'user'),
    ]);

    expect(llm.requests[0].contents[0].parts?.[0]?.text).toContain(
      "user: price is $& and $' and $`",
    );
  });
});

describe('formatEventsForPrompt', () => {
  it('renders text, tool calls and tool responses', () => {
    const events = [
      textEvent(1000, 'User says...', 'user'),
      textEvent(2000, 'Model replies...', 'model'),
      createEvent({timestamp: 3000, author: 'user'}),
      createEvent({
        timestamp: 4000,
        author: 'model',
        content: {parts: [{text: ''}]},
      }),
      createEvent({
        timestamp: 5000,
        author: 'model',
        content: {
          parts: [{functionCall: {id: 'call_1', name: 'tool', args: {q: 'x'}}}],
        },
      }),
      createEvent({
        timestamp: 6000,
        author: 'model',
        content: {
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'tool',
                response: {result: 'done'},
              },
            },
          ],
        },
      }),
    ];

    expect(formatEventsForPrompt(events)).toBe(
      [
        'user: User says...',
        'model: Model replies...',
        'model called tool: tool({"q":"x"})',
        'Tool response from tool: {"result":"done"}',
      ].join('\n'),
    );
  });

  it('includes thoughts', () => {
    const events = [
      textEvent(1000, 'What is the weather?', 'user'),
      createEvent({
        timestamp: 2000,
        author: 'model',
        content: {
          parts: [
            {text: 'Let me check the tool output.', thought: true},
            {text: 'It is sunny.'},
          ],
        },
      }),
    ];

    expect(formatEventsForPrompt(events)).toBe(
      [
        'user: What is the weather?',
        'model (thought): Let me check the tool output.',
        'model: It is sunny.',
      ].join('\n'),
    );
  });

  it('skips the thoughts of a prior compaction summary', () => {
    const events = [
      createEvent({
        timestamp: 1000,
        author: 'model',
        content: {
          parts: [
            {text: 'Stale summarizer reasoning.', thought: true},
            {text: 'Prior summary.'},
          ],
        },
        actions: {
          compaction: {
            startTimestamp: 0,
            endTimestamp: 1000,
            compactedContent: {parts: [{text: 'Prior'}]},
          },
        },
      }),
      textEvent(2000, 'New user input', 'user'),
    ];

    expect(formatEventsForPrompt(events)).toBe(
      'model: Prior summary.\nuser: New user input',
    );
  });

  it('truncates an oversized tool response', () => {
    const large = 'x'.repeat(2500);
    const events = [
      createEvent({
        timestamp: 1000,
        author: 'model',
        content: {
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'search',
                response: {data: large},
              },
            },
          ],
        },
      }),
    ];

    const formatted = formatEventsForPrompt(events);
    expect(formatted).toBe(
      `Tool response from search: ${truncate(JSON.stringify({data: large}))}`,
    );
    expect(formatted).toContain('... [truncated ');
    expect(formatted.length).toBeLessThan(large.length);
  });

  it('truncates oversized tool call args', () => {
    const large = 'y'.repeat(2500);
    const events = [
      createEvent({
        timestamp: 1000,
        author: 'model',
        content: {
          parts: [{functionCall: {id: 'c1', name: 'search', args: {q: large}}}],
        },
      }),
    ];

    expect(formatEventsForPrompt(events)).toBe(
      `model called tool: search(${truncate(JSON.stringify({q: large}))})`,
    );
  });
});

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
  });

  it('returns text at the limit unchanged', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('marks how many characters were dropped', () => {
    expect(truncate('abcdefgh', 3)).toBe('abc... [truncated 5 chars]');
  });

  it('caps at 2000 characters by default', () => {
    expect(truncate('z'.repeat(2001))).toBe(
      `${'z'.repeat(2000)}... [truncated 1 chars]`,
    );
  });
});
