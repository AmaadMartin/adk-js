/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEventsSummarizer,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  createEventsCompactionConfig,
  createSession,
  Event,
  EventsCompactionConfig,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {runCompactionForSlidingWindow} from '../../src/apps/compaction.js';
import {RunnableRoot} from '../../src/workflow/run_node_as_invocation.js';

class DummyAgent extends BaseAgent {
  constructor(name = 'dummy_agent') {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

/** A model that answers with one canned line and records every request. */
class CannedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly reply: string) {
    super({model: 'canned-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield {content: {role: 'model', parts: [{text: this.reply}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('CannedLlm does not support live mode.');
  }
}

/** Records the window it was handed and returns a canned event. */
class StubSummarizer implements BaseEventsSummarizer {
  readonly calls: Event[][] = [];

  constructor(private readonly result: Event | undefined) {}

  async maybeSummarizeEvents(events: Event[]): Promise<Event | undefined> {
    this.calls.push(events);
    return this.result;
  }
}

function textEvent(
  timestamp: number,
  invocationId: string,
  text: string,
): Event {
  return createEvent({
    timestamp,
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function functionCallEvent(
  timestamp: number,
  invocationId: string,
  callId: string,
): Event {
  return createEvent({
    timestamp,
    invocationId,
    author: 'agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id: callId, name: 'tool', args: {}}}],
    },
  });
}

function functionResponseEvent(
  timestamp: number,
  invocationId: string,
  callId: string,
): Event {
  return createEvent({
    timestamp,
    invocationId,
    author: 'agent',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: callId,
            name: 'tool',
            response: {result: 'ok'},
          },
        },
      ],
    },
  });
}

function toolConfirmationEvent(
  timestamp: number,
  invocationId: string,
  callId: string,
): Event {
  const event = functionResponseEvent(timestamp, invocationId, callId);
  event.actions.requestedToolConfirmations = {
    [callId]: {hint: 'Please confirm this action.', confirmed: false},
  };
  return event;
}

function authRequestEvent(
  timestamp: number,
  invocationId: string,
  callId: string,
): Event {
  const event = functionResponseEvent(timestamp, invocationId, callId);
  event.actions.requestedAuthConfigs = {
    [callId]: {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      credentialKey: callId,
    },
  };
  return event;
}

function compactionEvent(
  startTimestamp: number,
  endTimestamp: number,
  summaryText: string,
): Event {
  return createEvent({
    timestamp: endTimestamp,
    invocationId: 'compaction-inv',
    author: 'compactor',
    actions: {
      compaction: {
        startTimestamp,
        endTimestamp,
        compactedContent: {role: 'model', parts: [{text: summaryText}]},
      },
    },
  });
}

function sessionWith(events: Event[]): Session {
  return createSession({id: 's1', appName: 'test', userId: 'u1', events});
}

async function drain(params: {
  config: EventsCompactionConfig;
  rootAgent: RunnableRoot;
  session: Session;
}): Promise<Event[]> {
  const yielded: Event[] = [];
  for await (const event of runCompactionForSlidingWindow(params)) {
    yielded.push(event);
  }
  return yielded;
}

function windowInvocationIds(summarizer: StubSummarizer): string[][] {
  return summarizer.calls.map((events) =>
    events.map((event) => event.invocationId),
  );
}

describe('runCompactionForSlidingWindow', () => {
  it('does not summarize a session with no events', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 2, 'Summary'));

    const yielded = await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 1,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([]),
    });

    expect(yielded).toEqual([]);
    expect(summarizer.calls).toEqual([]);
  });

  it('yields the compaction event without appending it', async () => {
    const compaction = compactionEvent(1, 4, 'Summary inv1-inv4');
    const summarizer = new StubSummarizer(compaction);
    const session = sessionWith([
      textEvent(1, 'inv1', 'e1'),
      textEvent(2, 'inv2', 'e2'),
      textEvent(3, 'inv3', 'e3'),
      textEvent(4, 'inv4', 'e4'),
    ]);

    const yielded = await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 1,
      }),
      rootAgent: new DummyAgent(),
      session,
    });

    expect(yielded).toEqual([compaction]);
    expect(session.events).toHaveLength(4);
  });

  it('yields nothing when the summarizer returns undefined', async () => {
    const summarizer = new StubSummarizer(undefined);

    const yielded = await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 1,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([textEvent(1, 'inv1', 'e1')]),
    });

    expect(yielded).toEqual([]);
    expect(summarizer.calls).toHaveLength(1);
  });

  it('does not summarize below the compaction interval', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 2, 'Summary'));

    const yielded = await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 3,
        overlapSize: 1,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        textEvent(2, 'inv2', 'e2'),
      ]),
    });

    expect(yielded).toEqual([]);
    expect(summarizer.calls).toEqual([]);
  });

  it('covers every invocation on the first compaction', async () => {
    const summarizer = new StubSummarizer(
      compactionEvent(1, 4, 'Summary inv1-inv4'),
    );

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 1,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        textEvent(2, 'inv2', 'e2'),
        textEvent(3, 'inv3', 'e3'),
        textEvent(4, 'inv4', 'e4'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([
      ['inv1', 'inv2', 'inv3', 'inv4'],
    ]);
  });

  it('reaches back overlapSize invocations past a prior compaction', async () => {
    const summarizer = new StubSummarizer(
      compactionEvent(2, 5, 'Summary inv2-inv5'),
    );

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 1,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        textEvent(2, 'inv2', 'e2'),
        compactionEvent(1, 2, 'Summary inv1-inv2'),
        textEvent(3, 'inv3', 'e3'),
        textEvent(4, 'inv4', 'e4'),
        textEvent(5, 'inv5', 'e5'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([
      ['inv2', 'inv3', 'inv4', 'inv5'],
    ]);
  });

  it('stops the window before a pending function call', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 1, 'Summary'));

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        functionCallEvent(2, 'inv2', 'pending-call-1'),
        textEvent(3, 'inv3', 'e3'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([['inv1']]);
  });

  it('stops the window before an open tool confirmation', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 1, 'Summary'));

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        functionCallEvent(2, 'inv2', 'call-1'),
        toolConfirmationEvent(3, 'inv2', 'call-1'),
        textEvent(4, 'inv3', 'e3'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([['inv1']]);
  });

  it('stops the window before an open auth request', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 1, 'Summary'));

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        functionCallEvent(2, 'inv2', 'call-1'),
        authRequestEvent(3, 'inv2', 'call-1'),
        textEvent(4, 'inv3', 'e3'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([['inv1']]);
  });

  it('compacts a resolved call and response pair', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 4, 'Summary'));

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        functionCallEvent(2, 'inv2', 'completed-call-1'),
        functionResponseEvent(3, 'inv2', 'completed-call-1'),
        textEvent(4, 'inv3', 'e3'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([
      ['inv1', 'inv2', 'inv2', 'inv3'],
    ]);
  });

  it('yields nothing when the window has no self-contained prefix', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 2, 'Summary'));

    const yielded = await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        functionCallEvent(1, 'inv1', 'pending-call-1'),
        textEvent(2, 'inv2', 'e2'),
      ]),
    });

    expect(yielded).toEqual([]);
    expect(summarizer.calls).toEqual([]);
  });

  it('skips events that carry no invocation id', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 3, 'Summary'));
    const orphan = textEvent(2, 'inv-orphan', 'orphan');
    orphan.invocationId = '';

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1'),
        orphan,
        textEvent(3, 'inv2', 'e2'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([['inv1', '', 'inv2']]);
  });

  it('takes the latest timestamp of an invocation split across events', async () => {
    const summarizer = new StubSummarizer(compactionEvent(1, 3, 'Summary'));

    await drain({
      config: createEventsCompactionConfig({
        summarizer,
        compactionInterval: 2,
        overlapSize: 0,
      }),
      rootAgent: new DummyAgent(),
      session: sessionWith([
        textEvent(1, 'inv1', 'e1a'),
        textEvent(2, 'inv1', 'e1b'),
        textEvent(3, 'inv2', 'e2'),
      ]),
    });

    expect(windowInvocationIds(summarizer)).toEqual([['inv1', 'inv1', 'inv2']]);
  });

  it('falls back to an LlmEventSummarizer over the root agent model', async () => {
    const llm = new CannedLlm('Model-written summary');
    const yielded = await drain({
      config: createEventsCompactionConfig({
        compactionInterval: 1,
        overlapSize: 0,
      }),
      rootAgent: new LlmAgent({name: 'root_agent', model: llm}),
      session: sessionWith([textEvent(1, 'inv1', 'e1')]),
    });

    expect(llm.requests).toHaveLength(1);
    expect(yielded).toHaveLength(1);
    expect(
      yielded[0].actions.compaction?.compactedContent.parts?.[0]?.text,
    ).toBe('Model-written summary');
  });

  it('throws when no summarizer is configured and the root is not an LlmAgent', async () => {
    await expect(
      drain({
        config: createEventsCompactionConfig({
          compactionInterval: 1,
          overlapSize: 0,
        }),
        rootAgent: new DummyAgent(),
        session: sessionWith([textEvent(1, 'inv1', 'e1')]),
      }),
    ).rejects.toThrowError(
      'No LlmAgent model available for event compaction summarizer.',
    );
  });
});
