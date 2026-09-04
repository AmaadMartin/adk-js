/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseSummarizer, CompactedEvent, Event, createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';

class NullSummarizer implements BaseSummarizer {
  async summarize(): Promise<CompactedEvent | null> {
    return null;
  }
}

class CompactedEventSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent | null> {
    return {
      ...createEvent({id: 'summary', author: 'system'}),
      isCompacted: true,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: `Summary of ${events.length} events`,
    };
  }
}

describe('BaseSummarizer', () => {
  it('accepts a summarizer that declines with null', async () => {
    const summarizer: BaseSummarizer = new NullSummarizer();

    expect(await summarizer.summarize([createEvent({author: 'user'})])).toBe(
      null,
    );
  });

  it('accepts a summarizer that returns a compacted event', async () => {
    const summarizer: BaseSummarizer = new CompactedEventSummarizer();
    const events = [
      createEvent({author: 'user'}),
      createEvent({author: 'user'}),
    ];

    const result = await summarizer.summarize(events);

    if (!result) {
      expect.fail('expected a compacted event');
    }
    expect(result.isCompacted).toBe(true);
    expect(result.compactedContent).toBe('Summary of 2 events');
    expect(result.startTime).toBe(events[0].timestamp);
    expect(result.endTime).toBe(events[1].timestamp);
  });
});
