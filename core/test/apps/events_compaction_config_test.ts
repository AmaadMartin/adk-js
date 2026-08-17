/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEventsCompactionConfig,
  EventsCompactionConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {App} from '../../src/apps/app.js';

class DummyAgent extends BaseAgent {
  constructor(name = 'dummy_agent') {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

describe('createEventsCompactionConfig', () => {
  it('accepts a valid sliding-window pair', () => {
    const config = createEventsCompactionConfig({
      compactionInterval: 4,
      overlapSize: 1,
    });

    expect(config.compactionInterval).toBe(4);
    expect(config.overlapSize).toBe(1);
    expect(config.summarizer).toBeUndefined();
  });

  it('keeps an explicit summarizer', () => {
    const summarizer = {maybeSummarizeEvents: async () => undefined};
    const config = createEventsCompactionConfig({
      compactionInterval: 2,
      overlapSize: 0,
      summarizer,
    });

    expect(config.summarizer).toBe(summarizer);
  });

  it('rejects a compactionInterval without an overlapSize', () => {
    expect(() =>
      createEventsCompactionConfig({compactionInterval: 2}),
    ).toThrowError(/overlapSize must be 0 or more, got undefined/);
  });

  it('rejects an overlapSize without a compactionInterval', () => {
    expect(() => createEventsCompactionConfig({overlapSize: 1})).toThrowError(
      /compactionInterval must be greater than 0, got undefined/,
    );
  });

  it('rejects a zero compactionInterval', () => {
    expect(() =>
      createEventsCompactionConfig({compactionInterval: 0, overlapSize: 1}),
    ).toThrowError(/compactionInterval must be greater than 0, got 0/);
  });

  it('rejects a negative overlapSize', () => {
    expect(() =>
      createEventsCompactionConfig({compactionInterval: 2, overlapSize: -1}),
    ).toThrowError(/overlapSize must be 0 or more, got -1/);
  });
});

describe('App with eventsCompactionConfig', () => {
  it('stores a valid config', () => {
    const config = createEventsCompactionConfig({
      compactionInterval: 3,
      overlapSize: 2,
    });
    const app = new App({
      name: 'test_app',
      rootAgent: new DummyAgent(),
      eventsCompactionConfig: config,
    });

    expect(app.eventsCompactionConfig).toBe(config);
  });

  it('leaves the field undefined when no config is supplied', () => {
    const app = new App({name: 'test_app', rootAgent: new DummyAgent()});

    expect(app.eventsCompactionConfig).toBeUndefined();
  });

  it('rejects an invalid literal that bypassed the factory', () => {
    const config: EventsCompactionConfig = {
      compactionInterval: 0,
      overlapSize: 1,
    };

    expect(
      () =>
        new App({
          name: 'test_app',
          rootAgent: new DummyAgent(),
          eventsCompactionConfig: config,
        }),
    ).toThrowError(/compactionInterval must be greater than 0, got 0/);
  });
});
