/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BaseSummarizer,
  CompactedEvent,
  Event,
  EventActions,
  LlmRequest,
} from '@google/adk';
import {
  AgentControlledContextCompactor,
  CONTENT_REQUEST_PROCESSOR,
  createEvent,
  createEventActions,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  TokenBasedContextCompactor,
} from '@google/adk';
import type {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {applyRewinds} from '../../src/events/rewind_events.js';

/** Text carried only by the invocation that the user rewinds (undoes). */
const REWOUND_TEXT = 'SECRET_REWOUND_CONTENT';

/** Prefix the echo summarizer stamps on every summary it produces. */
const SUMMARY_MARKER = 'COMPACTED_SUMMARY_MARKER';

function userEvent(invocationId: string, text: string, timestamp = 0): Event {
  return createEvent({
    invocationId,
    author: 'user',
    timestamp,
    content: {role: 'user', parts: [{text}]},
  });
}

function modelEvent(invocationId: string, text: string, timestamp = 0): Event {
  return createEvent({
    invocationId,
    author: 'agent',
    timestamp,
    content: {role: 'model', parts: [{text}]},
  });
}

function rewindMarker(
  invocationId: string,
  rewindBeforeInvocationId: string,
  timestamp = 0,
): Event {
  return createEvent({
    invocationId,
    author: 'user',
    timestamp,
    actions: createEventActions({rewindBeforeInvocationId}),
  });
}

function contentsText(contents: Content[]): string {
  return contents
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n');
}

function eventsText(events: Event[]): string {
  return contentsText(
    events.flatMap((event) => (event.content ? [event.content] : [])),
  );
}

function ids(events: Event[]): string[] {
  return events.map((event) => event.id);
}

describe('applyRewinds', () => {
  it('returns an empty array for an empty history', () => {
    expect(applyRewinds([])).toEqual([]);
  });

  it('returns the same events, in order and by identity, when there is no marker', () => {
    const events = [userEvent('inv1', 'one'), modelEvent('inv1', 'two')];

    const result = applyRewinds(events);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(events[0]);
    expect(result[1]).toBe(events[1]);
  });

  it('drops the rewound invocation and the marker itself', () => {
    const events = [
      userEvent('inv1', 'hello'),
      modelEvent('inv1', 'hi'),
      userEvent('inv_to_rewind', REWOUND_TEXT),
      modelEvent('inv_to_rewind', 'acknowledged'),
      rewindMarker('rewind_inv', 'inv_to_rewind'),
      userEvent('inv3', 'third message'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[0], events[1], events[5]]));
  });

  it('drops every event of a rewound invocation that spans more than two events', () => {
    const events = [
      userEvent('inv1', 'keep me'),
      userEvent('inv_to_rewind', `${REWOUND_TEXT} a`),
      modelEvent('inv_to_rewind', `${REWOUND_TEXT} b`),
      modelEvent('inv_to_rewind', `${REWOUND_TEXT} c`),
      rewindMarker('rewind_inv', 'inv_to_rewind'),
      userEvent('inv3', 'later'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[0], events[5]]));
  });

  it('drops only the marker when its target invocation is not in the history', () => {
    const events = [
      userEvent('inv1', 'one'),
      modelEvent('inv1', 'two'),
      rewindMarker('rewind_inv', 'never_happened'),
      userEvent('inv3', 'three'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[0], events[1], events[3]]));
  });

  it('does not let a marker match its own invocation id', () => {
    const events = [
      userEvent('inv1', 'one'),
      rewindMarker('inv_self', 'inv_self'),
      userEvent('inv2', 'two'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[0], events[2]]));
  });

  it('resumes the walk from the jump point so earlier markers still apply', () => {
    const events = [
      userEvent('inv1', 'one'),
      userEvent('inv2', 'two'),
      rewindMarker('rewind_a', 'inv2'),
      userEvent('inv3', 'three'),
      rewindMarker('rewind_b', 'inv3'),
      userEvent('inv4', 'four'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[0], events[5]]));
  });

  it('ignores a marker whose target invocation only appears after it', () => {
    const events = [
      rewindMarker('rewind_inv', 'inv_later'),
      userEvent('inv_later', 'later'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[1]]));
  });

  it('drops a marker sitting at index 0 without failing', () => {
    const events = [
      rewindMarker('rewind_inv', 'never_happened'),
      userEvent('inv1', 'one'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[1]]));
  });

  it('tolerates events whose actions are absent at runtime', () => {
    const withoutActions = userEvent('inv1', 'one');
    // A history restored from a store can arrive without `actions` even though
    // the interface declares it, so the helper must not dereference it blindly.
    const optionalView: {actions?: EventActions} = withoutActions;
    delete optionalView.actions;

    const events = [
      withoutActions,
      rewindMarker('rewind_inv', 'never_happened'),
      userEvent('inv2', 'two'),
    ];

    const result = applyRewinds(events);

    expect(ids(result)).toEqual(ids([events[0], events[2]]));
  });

  it('does not mutate the input array', () => {
    const events = [
      userEvent('inv1', 'one'),
      userEvent('inv_to_rewind', REWOUND_TEXT),
      rewindMarker('rewind_inv', 'inv_to_rewind'),
      userEvent('inv3', 'three'),
    ];
    const before = [...events];

    applyRewinds(events);

    expect(events).toHaveLength(before.length);
    expect(events).toEqual(before);
  });
});

/**
 * A summarizer whose summary echoes the text it was asked to compact, so a
 * rewound event reaching it is observable in the resulting prompt.
 */
class EchoSummarizer implements BaseSummarizer {
  readonly inputs: Event[][] = [];

  async summarize(events: Event[]): Promise<CompactedEvent> {
    this.inputs.push(events);
    const echoed = `${SUMMARY_MARKER} ${eventsText(events)}`;
    const last = events[events.length - 1];
    return {
      ...createEvent({
        author: 'system',
        timestamp: last.timestamp + 1,
        content: {role: 'model', parts: [{text: echoed}]},
      }),
      isCompacted: true,
      startTime: events[0].timestamp,
      endTime: last.timestamp,
      compactedContent: echoed,
    };
  }

  summarizedText(): string {
    return this.inputs.map(eventsText).join('\n');
  }
}

function createRewoundSession(trailingEvents: Event[]) {
  return createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state: {},
    events: [
      userEvent('inv1', 'hello', 1000),
      modelEvent('inv1', 'hi', 2000),
      userEvent('inv_to_rewind', REWOUND_TEXT, 3000),
      modelEvent('inv_to_rewind', 'acknowledged', 4000),
      rewindMarker('rewind_inv', 'inv_to_rewind', 5000),
      ...trailingEvents,
    ],
  });
}

function createInvocationContext(
  session: ReturnType<typeof createSession>,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
}

async function buildPrompt(
  invocationContext: InvocationContext,
): Promise<Content[]> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
  for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // The processor only mutates llmRequest; it yields nothing.
  }
  return llmRequest.contents;
}

describe('rewind + compaction + prompt building', () => {
  it('keeps rewound content out of a token-threshold compaction summary and the prompt', async () => {
    const summarizer = new EchoSummarizer();
    const compactor = new TokenBasedContextCompactor({
      tokenThreshold: 1,
      eventRetentionSize: 1,
      summarizer,
    });
    const invocationContext = createInvocationContext(
      createRewoundSession([userEvent('inv3', 'next', 6000)]),
    );

    await compactor.compact(invocationContext);
    const prompt = await buildPrompt(invocationContext);
    const promptText = contentsText(prompt);

    expect(summarizer.inputs).toHaveLength(1);
    expect(promptText).toContain(SUMMARY_MARKER);
    expect(summarizer.summarizedText()).not.toContain(REWOUND_TEXT);
    expect(promptText).not.toContain(REWOUND_TEXT);
  });

  it('keeps rewound content out of an agent-controlled compaction summary and the prompt', async () => {
    const summarizer = new EchoSummarizer();
    const compactor = new AgentControlledContextCompactor({summarizer});
    const session = createRewoundSession([
      createEvent({
        invocationId: 'inv3',
        author: 'agent',
        timestamp: 6000,
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'consolidate_context', args: {}}}],
        },
      }),
    ]);
    session.state['temp:consolidate_context'] = true;
    const invocationContext = createInvocationContext(session);

    expect(compactor.shouldCompact(invocationContext)).toBe(true);
    await compactor.compact(invocationContext);
    const prompt = await buildPrompt(invocationContext);
    const promptText = contentsText(prompt);

    expect(summarizer.inputs).toHaveLength(1);
    expect(promptText).toContain(SUMMARY_MARKER);
    expect(summarizer.summarizedText()).not.toContain(REWOUND_TEXT);
    expect(promptText).not.toContain(REWOUND_TEXT);
  });
});
