/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSummarizer,
  CompactedEvent,
  createCompactedEvent,
  createEvent,
  createEventsCompactionConfig,
  createSession,
  Event,
  runSlidingWindowCompaction,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

/** Records the window it was handed, so a test can assert the boundaries. */
class RecordingSummarizer implements BaseSummarizer {
  readonly windows: Event[][] = [];

  async summarize(events: Event[]): Promise<CompactedEvent> {
    this.windows.push(events);
    return createCompactedEvent({
      author: 'summarizer',
      invocationId: events[events.length - 1].invocationId,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: `summary of ${events.length} events`,
      timestamp: events[events.length - 1].timestamp + 1,
    });
  }

  /** The invocation ids of the window handed over on the given call. */
  invocationIdsAt(index: number): string[] {
    return [...new Set(this.windows[index].map((e) => e.invocationId))];
  }
}

let summarizer: RecordingSummarizer;

beforeEach(() => {
  summarizer = new RecordingSummarizer();
});

/** Two events for one invocation, at `timestamp` and `timestamp + 1`. */
function turn(invocationId: string, timestamp: number): Event[] {
  return [
    createEvent({invocationId, author: 'user', timestamp}),
    createEvent({invocationId, author: 'agent', timestamp: timestamp + 1}),
  ];
}

function sessionOf(events: Event[]): Session {
  return createSession({id: 's1', appName: 'app', userId: 'u1', events});
}

async function compact(
  session: Session,
  options: {compactionInterval: number; overlapSize: number},
): Promise<Event[]> {
  const config = createEventsCompactionConfig({...options, summarizer});
  const produced: Event[] = [];
  for await (const event of runSlidingWindowCompaction(config, session)) {
    produced.push(event);
  }
  return produced;
}

describe('runSlidingWindowCompaction', () => {
  it('yields nothing before the interval is reached', async () => {
    const session = sessionOf(turn('inv1', 100));

    const produced = await compact(session, {
      compactionInterval: 2,
      overlapSize: 0,
    });

    expect(produced).toEqual([]);
    expect(summarizer.windows).toEqual([]);
  });

  it('yields nothing for an empty session', async () => {
    const produced = await compact(sessionOf([]), {
      compactionInterval: 1,
      overlapSize: 0,
    });

    expect(produced).toEqual([]);
  });

  it('yields nothing for a session that holds only summaries', async () => {
    const session = sessionOf([
      createCompactedEvent({
        author: 'summarizer',
        invocationId: 'inv1',
        startTime: 100,
        endTime: 101,
        compactedContent: 'earlier',
        timestamp: 102,
      }),
    ]);

    const produced = await compact(session, {
      compactionInterval: 1,
      overlapSize: 0,
    });

    expect(produced).toEqual([]);
  });

  it('walks the window the adk-python docstring describes', async () => {
    // Interval 2, overlap 1, invocations 1-4: the first window is 1-2, the
    // third invocation alone is not enough, and the second window is 2-4.
    const events = [...turn('inv1', 100), ...turn('inv2', 200)];
    const session = sessionOf(events);

    const first = await compact(session, {
      compactionInterval: 2,
      overlapSize: 1,
    });
    expect(first).toHaveLength(1);
    expect(summarizer.invocationIdsAt(0)).toEqual(['inv1', 'inv2']);

    session.events.push(first[0], ...turn('inv3', 300));
    const second = await compact(session, {
      compactionInterval: 2,
      overlapSize: 1,
    });
    expect(second).toEqual([]);

    session.events.push(...turn('inv4', 400));
    const third = await compact(session, {
      compactionInterval: 2,
      overlapSize: 1,
    });
    expect(third).toHaveLength(1);
    expect(summarizer.invocationIdsAt(1)).toEqual(['inv2', 'inv3', 'inv4']);
  });

  it('starts at the first new invocation when there is no overlap', async () => {
    const session = sessionOf([
      ...turn('inv1', 100),
      createCompactedEvent({
        author: 'summarizer',
        invocationId: 'inv1',
        startTime: 100,
        endTime: 101,
        compactedContent: 'earlier',
        timestamp: 102,
      }),
      ...turn('inv2', 200),
      ...turn('inv3', 300),
    ]);

    await compact(session, {compactionInterval: 2, overlapSize: 0});

    expect(summarizer.invocationIdsAt(0)).toEqual(['inv2', 'inv3']);
  });

  it('keeps an earlier summary out of the window it hands over', async () => {
    const session = sessionOf([
      ...turn('inv1', 100),
      createCompactedEvent({
        author: 'summarizer',
        invocationId: 'inv1',
        startTime: 100,
        endTime: 101,
        compactedContent: 'earlier',
        timestamp: 102,
      }),
      ...turn('inv2', 200),
      ...turn('inv3', 300),
    ]);

    await compact(session, {compactionInterval: 2, overlapSize: 5});

    expect(summarizer.windows[0].map((e) => e.author)).toEqual([
      'user',
      'agent',
      'user',
      'agent',
      'user',
      'agent',
    ]);
  });

  it('counts an invocation as new by the end time of the last summary', async () => {
    // inv2 ran before the summary that covers it, so only inv3 is new and the
    // interval of 2 is not met.
    const session = sessionOf([
      ...turn('inv1', 100),
      ...turn('inv2', 200),
      createCompactedEvent({
        author: 'summarizer',
        invocationId: 'inv2',
        startTime: 100,
        endTime: 201,
        compactedContent: 'earlier',
        timestamp: 202,
      }),
      ...turn('inv3', 300),
    ]);

    const produced = await compact(session, {
      compactionInterval: 2,
      overlapSize: 0,
    });

    expect(produced).toEqual([]);
  });

  it('does nothing when the policy names no sliding window', async () => {
    const session = sessionOf([...turn('inv1', 100), ...turn('inv2', 200)]);
    const produced: Event[] = [];

    for await (const event of runSlidingWindowCompaction(
      createEventsCompactionConfig({
        tokenThreshold: 100,
        eventRetentionSize: 2,
        summarizer,
      }),
      session,
    )) {
      produced.push(event);
    }

    expect(produced).toEqual([]);
    expect(summarizer.windows).toEqual([]);
  });

  it('does nothing when the policy names no summarizer', async () => {
    const session = sessionOf([...turn('inv1', 100), ...turn('inv2', 200)]);
    const produced: Event[] = [];

    for await (const event of runSlidingWindowCompaction(
      createEventsCompactionConfig({compactionInterval: 2, overlapSize: 0}),
      session,
    )) {
      produced.push(event);
    }

    expect(produced).toEqual([]);
  });

  it('skips an event that carries no invocation id', async () => {
    const session = sessionOf([
      createEvent({author: 'system', timestamp: 50}),
      ...turn('inv1', 100),
      ...turn('inv2', 200),
    ]);

    await compact(session, {compactionInterval: 2, overlapSize: 0});

    expect(summarizer.invocationIdsAt(0)).toEqual(['inv1', 'inv2']);
  });
});
