/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A live run has two sources of events: the root's own stream, and the queue
 * that code running underneath the root pushes onto. These cover the merge of
 * the two, and what its teardown may and may not wait for.
 */

import {describe, expect, it, vi} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {mergeLiveEventStreams} from '../../src/runner/live_event_merge.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';

async function* eventsOf(
  ...events: Event[]
): AsyncGenerator<Event, void, void> {
  for (const event of events) {
    yield event;
  }
}

function testEvent(author: string): Event {
  return createEvent({author, invocationId: 'inv', output: author});
}

describe('mergeLiveEventStreams', () => {
  it('surfaces events from both streams', async () => {
    const queue = new AsyncQueue<Event>();
    queue.push(testEvent('queued'));
    const merged = mergeLiveEventStreams(queue, eventsOf(testEvent('root')));

    const authors: string[] = [];
    for await (const event of merged) {
      authors.push(event.author!);
    }

    expect(authors.sort()).toEqual(['queued', 'root']);
  });

  it('ends once the root has ended, without the caller closing the queue', async () => {
    const queue = new AsyncQueue<Event>();
    const merged = mergeLiveEventStreams(queue, eventsOf(testEvent('root')));

    const authors: string[] = [];
    for await (const event of merged) {
      authors.push(event.author!);
    }

    expect(authors).toEqual(['root']);
    expect(queue.isClosed).toBe(true);
  });

  it('keeps merging root events after the queue has closed', async () => {
    const queue = new AsyncQueue<Event>();
    queue.close();
    const merged = mergeLiveEventStreams(
      queue,
      eventsOf(testEvent('one'), testEvent('two')),
    );

    const authors: string[] = [];
    for await (const event of merged) {
      authors.push(event.author!);
    }

    expect(authors).toEqual(['one', 'two']);
  });

  it('delivers a root failure to the caller after the earlier events', async () => {
    const queue = new AsyncQueue<Event>();
    async function* failingRoot(): AsyncGenerator<Event, void, void> {
      yield testEvent('root');
      throw new Error('root failed');
    }

    const seen: Event[] = [];
    await expect(async () => {
      for await (const event of mergeLiveEventStreams(queue, failingRoot())) {
        seen.push(event);
      }
    }).rejects.toThrow('root failed');

    expect(seen.map((e) => e.author)).toEqual(['root']);
    expect(queue.isClosed).toBe(true);
  });

  it('delivers a queue failure to the caller', async () => {
    const queue = new AsyncQueue<Event>();
    queue.fail(new Error('queue failed'));

    await expect(async () => {
      for await (const _ of mergeLiveEventStreams(
        queue,
        eventsOf(testEvent('root')),
      )) {
        // no-op
      }
    }).rejects.toThrow('queue failed');
  });

  it('ends the root when the caller stops early', async () => {
    const queue = new AsyncQueue<Event>();
    let unwound = false;
    async function* root(): AsyncGenerator<Event, void, void> {
      try {
        yield testEvent('one');
        yield testEvent('two');
      } finally {
        unwound = true;
      }
    }

    for await (const _ of mergeLiveEventStreams(queue, root())) {
      break;
    }

    expect(unwound).toBe(true);
    expect(queue.isClosed).toBe(true);
  });

  it('returns to a caller that stops after a queued event, with the root idle', async () => {
    const queue = new AsyncQueue<Event>();
    const gate = new AsyncQueue<Event>();
    let unwound = false;
    async function* idleRoot(): AsyncGenerator<Event, void, void> {
      try {
        for await (const event of gate) {
          yield event;
        }
      } finally {
        unwound = true;
      }
    }
    queue.push(testEvent('queued'));

    // A pull on the root is necessarily in flight while a queued event is
    // delivered, so the stop request cannot run yet. The caller must not be
    // made to wait for it.
    const seen: Event[] = [];
    for await (const event of mergeLiveEventStreams(queue, idleRoot())) {
      seen.push(event);
      break;
    }

    expect(seen.map((e) => e.author)).toEqual(['queued']);
    expect(unwound).toBe(false);

    // The stop takes effect as soon as the root produces again.
    gate.push(testEvent('late'));
    await vi.waitFor(() => {
      expect(unwound).toBe(true);
    });
  });

  it('returns to a caller that stops after a queued event when the queue then fails', async () => {
    const queue = new AsyncQueue<Event>();
    const gate = new AsyncQueue<Event>();
    async function* idleRoot(): AsyncGenerator<Event, void, void> {
      for await (const event of gate) {
        yield event;
      }
    }
    queue.push(testEvent('queued'));

    for await (const _ of mergeLiveEventStreams(queue, idleRoot())) {
      queue.fail(new Error('queue failed after the caller stopped'));
      break;
    }

    expect(queue.isClosed).toBe(true);
  });
});
