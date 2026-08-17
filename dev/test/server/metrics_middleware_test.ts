/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestMetricsDriver} from '@google/adk';
import express from 'express';
import {EventEmitter} from 'node:events';
import {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  driveRequestMetrics,
  metricsFlushingMiddleware,
} from '../../src/server/metrics_middleware.js';

type Interaction = 'start' | 'submit' | 'end' | 'handler';

/** Records the order of the reader calls the middleware makes. */
class SpyReader implements RequestMetricsDriver {
  readonly events: Interaction[] = [];
  startResult = true;
  endResult = true;
  throwOnStart = false;
  throwOnEnd = false;

  noteRequestStart(): boolean {
    this.events.push('start');
    if (this.throwOnStart) {
      throw new Error('start hook failed');
    }
    return this.startResult;
  }

  noteRequestEnd(): boolean {
    this.events.push('end');
    if (this.throwOnEnd) {
      throw new Error('end hook failed');
    }
    return this.endResult;
  }

  async submitCollect(): Promise<void> {
    this.events.push('submit');
  }
}

/** Waits for the drain, which runs from a completion listener. */
async function waitForDrain(reader: SpyReader): Promise<void> {
  await vi.waitFor(() => expect(reader.events).toContain('end'));
}

describe('driveRequestMetrics', () => {
  it('collects on entry and drains on finish', async () => {
    const reader = new SpyReader();
    const res = new EventEmitter();

    driveRequestMetrics(reader, res);
    expect(reader.events).toEqual(['start', 'submit']);

    res.emit('finish');
    await waitForDrain(reader);
    expect(reader.events).toEqual(['start', 'submit', 'end', 'submit']);
  });

  it('drains exactly once when finish is followed by close', async () => {
    const reader = new SpyReader();
    const res = new EventEmitter();

    driveRequestMetrics(reader, res);
    res.emit('finish');
    res.emit('close');
    await waitForDrain(reader);

    expect(reader.events.filter((e) => e === 'end')).toEqual(['end']);
  });

  it('drains on a client abort that never finishes', async () => {
    const reader = new SpyReader();
    const res = new EventEmitter();

    driveRequestMetrics(reader, res);
    res.emit('close');
    await waitForDrain(reader);

    expect(reader.events).toEqual(['start', 'submit', 'end', 'submit']);
  });

  it('submits no collect when the reader declines', async () => {
    const reader = new SpyReader();
    reader.startResult = false;
    reader.endResult = false;
    const res = new EventEmitter();

    driveRequestMetrics(reader, res);
    expect(reader.events).toEqual(['start']);

    res.emit('finish');
    await waitForDrain(reader);
    expect(reader.events).toEqual(['start', 'end']);
  });

  it('still drains when the start hook throws', async () => {
    const reader = new SpyReader();
    reader.throwOnStart = true;
    const res = new EventEmitter();

    expect(() => driveRequestMetrics(reader, res)).not.toThrow();

    res.emit('finish');
    await waitForDrain(reader);
    expect(reader.events).toEqual(['start', 'end', 'submit']);
  });

  it('does not throw out of the finish listener when the end hook throws', async () => {
    const reader = new SpyReader();
    reader.throwOnEnd = true;
    const res = new EventEmitter();

    driveRequestMetrics(reader, res);
    expect(() => res.emit('finish')).not.toThrow();
    await waitForDrain(reader);
    expect(reader.events).toEqual(['start', 'submit', 'end']);
  });
});

describe('metricsFlushingMiddleware', () => {
  let server: ReturnType<express.Express['listen']> | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) {
      await new Promise<void>((resolve) => running.close(() => resolve()));
    }
  });

  it('drains after the handler has replied', async () => {
    const reader = new SpyReader();
    const app = express();
    app.use(metricsFlushingMiddleware(reader));
    app.get('/ping', (_req, res) => {
      reader.events.push('handler');
      res.status(200).send('pong');
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const {port} = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(await response.text()).toBe('pong');

    await waitForDrain(reader);
    expect(reader.events.indexOf('start')).toBeLessThan(
      reader.events.indexOf('handler'),
    );
    expect(reader.events.indexOf('handler')).toBeLessThan(
      reader.events.indexOf('end'),
    );
  });
});
