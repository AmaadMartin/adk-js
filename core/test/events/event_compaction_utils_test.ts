/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {applyEventCompactions} from '../../src/events/event_compaction_utils.js';

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

function compactionEvent(params: {
  startTimestamp: number;
  endTimestamp: number;
  summaryText: string;
  appendedTimestamp?: number;
}): Event {
  const {startTimestamp, endTimestamp, summaryText} = params;
  return createEvent({
    timestamp: params.appendedTimestamp ?? endTimestamp,
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

function texts(events: Event[]): Array<string | undefined> {
  return events.map((event) => event.content?.parts?.[0]?.text);
}

describe('applyEventCompactions', () => {
  it('returns the events unchanged when none carries a compaction', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      textEvent(3, 'inv3', 'Event 3'),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Event 1',
      'Event 2',
      'Event 3',
    ]);
  });

  it('replaces the covered events with a compaction at the start', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 2,
        summaryText: 'Summary 1-2',
      }),
      textEvent(3, 'inv3', 'Event 3'),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1-2',
      'Event 3',
    ]);
  });

  it('replaces the covered events for compactions in the middle', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 2,
        summaryText: 'Summary 1-2',
      }),
      textEvent(3, 'inv3', 'Event 3'),
      textEvent(4, 'inv4', 'Event 4'),
      compactionEvent({
        startTimestamp: 3,
        endTimestamp: 4,
        summaryText: 'Summary 3-4',
      }),
      textEvent(5, 'inv5', 'Event 5'),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1-2',
      'Summary 3-4',
      'Event 5',
    ]);
  });

  it('keeps events outside a compaction that sits at the end', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      textEvent(3, 'inv3', 'Event 3'),
      compactionEvent({
        startTimestamp: 2,
        endTimestamp: 3,
        summaryText: 'Summary 2-3',
      }),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Event 1',
      'Summary 2-3',
    ]);
  });

  it('materializes a compaction whose covered events are already gone', () => {
    const events = [
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 2,
        summaryText: 'Summary 1-2',
      }),
      textEvent(3, 'inv3', 'Event 3'),
      textEvent(4, 'inv4', 'Event 4'),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1-2',
      'Event 3',
      'Event 4',
    ]);
  });

  it('applies multiple non-overlapping compactions in timestamp order', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      textEvent(3, 'inv3', 'Event 3'),
      textEvent(4, 'inv4', 'Event 4'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 4,
        summaryText: 'Summary 1-4',
      }),
      textEvent(5, 'inv5', 'Event 5'),
      textEvent(6, 'inv6', 'Event 6'),
      textEvent(7, 'inv7', 'Event 7'),
      textEvent(8, 'inv8', 'Event 8'),
      textEvent(9, 'inv9', 'Event 9'),
      compactionEvent({
        startTimestamp: 6,
        endTimestamp: 9,
        summaryText: 'Summary 6-9',
      }),
      textEvent(10, 'inv10', 'Event 10'),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1-4',
      'Event 5',
      'Summary 6-9',
      'Event 10',
    ]);
  });

  it('hides a compaction that a wider compaction subsumes', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      textEvent(3, 'inv3', 'Event 3'),
      textEvent(4, 'inv4', 'Event 4'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 1,
        summaryText: 'Summary 1',
      }),
      textEvent(6, 'inv6', 'Event 6'),
      textEvent(7, 'inv7', 'Event 7'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 3,
        summaryText: 'Summary 1-3',
      }),
      textEvent(9, 'inv9', 'Event 9'),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1-3',
      'Event 4',
      'Event 6',
      'Event 7',
      'Event 9',
    ]);
  });

  it('keeps the later event when two compactions cover the same range', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 2,
        summaryText: 'Older summary',
      }),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 2,
        summaryText: 'Newer summary',
      }),
    ];

    expect(texts(applyEventCompactions(events))).toEqual(['Newer summary']);
  });

  it('keeps events newer than a late-appended compaction', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      textEvent(3, 'inv3', 'Event 3'),
      textEvent(4, 'inv4', 'Event 4'),
      textEvent(5, 'inv5', 'Event 5'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 3,
        summaryText: 'Summary 1-3',
        appendedTimestamp: 6,
      }),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1-3',
      'Event 4',
      'Event 5',
    ]);
  });

  it('ignores a compaction whose range is not fully specified', () => {
    // Models an event rehydrated from storage: the summary never made it to
    // disk, so the range cannot stand in for anything.
    const partial = JSON.parse(
      '{"id":"partial","invocationId":"inv-partial","author":"compactor",' +
        '"timestamp":3,"actions":{"stateDelta":{},"artifactDelta":{},' +
        '"requestedAuthConfigs":{},"requestedToolConfirmations":{},' +
        '"compaction":{"startTimestamp":1,"endTimestamp":2}}}',
    ) as Event;
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      partial,
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Event 1',
      'Event 2',
    ]);
  });

  it('attributes the materialized summary to the requested agent', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 1,
        summaryText: 'Summary 1',
      }),
    ];

    expect(applyEventCompactions(events, 'researcher')[0].author).toBe(
      'researcher',
    );
    expect(applyEventCompactions(events)[0].author).toBe('model');
  });

  it('carries the branch and invocation id of the compaction event', () => {
    const source = compactionEvent({
      startTimestamp: 1,
      endTimestamp: 1,
      summaryText: 'Summary 1',
    });
    source.branch = 'root.child';

    const [materialized] = applyEventCompactions([
      textEvent(1, 'inv1', 'Event 1'),
      source,
    ]);

    expect(materialized.branch).toBe('root.child');
    expect(materialized.invocationId).toBe('compaction-inv');
    expect(materialized.timestamp).toBe(1);
  });

  it('is idempotent over its own output', () => {
    const events = [
      textEvent(1, 'inv1', 'Event 1'),
      textEvent(2, 'inv2', 'Event 2'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 2,
        summaryText: 'Summary 1-2',
      }),
      textEvent(3, 'inv3', 'Event 3'),
    ];

    const once = applyEventCompactions(events);
    expect(texts(applyEventCompactions(once))).toEqual(texts(once));
  });

  it('keeps events sharing a timestamp in their original order', () => {
    const events = [
      textEvent(5, 'inv1', 'First at 5'),
      textEvent(5, 'inv2', 'Second at 5'),
      compactionEvent({
        startTimestamp: 1,
        endTimestamp: 1,
        summaryText: 'Summary 1',
      }),
    ];

    expect(texts(applyEventCompactions(events))).toEqual([
      'Summary 1',
      'First at 5',
      'Second at 5',
    ]);
  });
});
