/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, PluginManager} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** Records the order in which the manager closed the plugins. */
const closeOrder: string[] = [];

/** A plugin whose `close()` resolves, throws, or never settles. */
class ClosablePlugin extends BasePlugin {
  closeCount = 0;

  constructor(
    name: string,
    private readonly behaviour: 'resolve' | 'throw' | 'hang' = 'resolve',
  ) {
    super(name);
  }

  override async close(): Promise<void> {
    this.closeCount++;
    closeOrder.push(this.name);
    if (this.behaviour === 'throw') {
      throw new Error(`${this.name} could not release its socket`);
    }
    if (this.behaviour === 'hang') {
      return new Promise<void>(() => {});
    }
  }
}

describe('PluginManager.close', () => {
  afterEach(() => {
    closeOrder.length = 0;
    vi.useRealTimers();
  });

  it('closes every registered plugin in registration order', async () => {
    const first = new ClosablePlugin('first');
    const second = new ClosablePlugin('second');
    const manager = new PluginManager([first, second]);

    await manager.close();

    expect(closeOrder).toEqual(['first', 'second']);
    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
  });

  it('resolves when no plugin is registered', async () => {
    await expect(new PluginManager().close()).resolves.toBeUndefined();
  });

  it('closes the remaining plugins when an earlier one throws', async () => {
    const failing = new ClosablePlugin('failing', 'throw');
    const healthy = new ClosablePlugin('healthy');
    const manager = new PluginManager([failing, healthy]);

    await expect(manager.close()).rejects.toThrow(
      "Failed to close plugins: 'failing'",
    );
    expect(healthy.closeCount).toBe(1);
  });

  it('reports the cause of every plugin that failed', async () => {
    const manager = new PluginManager([
      new ClosablePlugin('alpha', 'throw'),
      new ClosablePlugin('beta', 'throw'),
    ]);

    const error = await manager.close().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe("Failed to close plugins: 'alpha', 'beta'");
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0].message).toContain(
      'alpha could not release its socket',
    );
    expect(aggregate.errors[1].message).toContain(
      'beta could not release its socket',
    );
  });

  it('abandons a plugin that never finishes closing', async () => {
    vi.useFakeTimers();
    const stuck = new ClosablePlugin('stuck', 'hang');
    const healthy = new ClosablePlugin('healthy');
    const manager = new PluginManager([stuck, healthy], 2);

    const closing = manager.close();
    const settled = closing.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await settled;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0].message).toBe(
      "Closing plugin 'stuck' timed out after 2s.",
    );
    expect(healthy.closeCount).toBe(1);
  });

  it('gives each plugin five seconds by default', async () => {
    vi.useFakeTimers();
    const manager = new PluginManager([new ClosablePlugin('stuck', 'hang')]);

    const settled = manager.close().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;

    expect((error as AggregateError).errors[0].message).toBe(
      "Closing plugin 'stuck' timed out after 5s.",
    );
  });

  it('waits indefinitely when the timeout is zero', async () => {
    vi.useFakeTimers();
    const slow = new ClosablePlugin('slow', 'hang');
    const manager = new PluginManager([slow], 0);

    const settled = manager.close().then(
      () => 'closed',
      () => 'failed',
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(vi.getTimerCount()).toBe(0);
    await expect(
      Promise.race([settled, Promise.resolve('still waiting')]),
    ).resolves.toBe('still waiting');
  });
});
