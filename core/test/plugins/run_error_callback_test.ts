/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, InvocationContext, PluginManager} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

/** Records the order in which the manager notified the plugins. */
const notifyOrder: string[] = [];

/** A plugin that records the run error, and optionally fails afterwards. */
class RunErrorPlugin extends BasePlugin {
  readonly seen: Array<{context: InvocationContext; error: Error}> = [];

  constructor(
    name: string,
    private readonly failWith?: Error,
  ) {
    super(name);
  }

  override async onRunErrorCallback({
    invocationContext,
    error,
  }: {
    invocationContext: InvocationContext;
    error: Error;
  }): Promise<void> {
    notifyOrder.push(this.name);
    this.seen.push({context: invocationContext, error});
    if (this.failWith) {
      throw this.failWith;
    }
  }
}

/** A plugin that leaves `onRunErrorCallback` at its default. */
class SilentPlugin extends BasePlugin {}

/** Collects the messages a run writes at error level. */
function recordErrors(): string[] {
  const messages: string[] = [];
  setLogger({
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => {
      messages.push(args.map((a) => String(a)).join(' '));
    },
  });
  return messages;
}

const invocationContext = {
  invocationId: 'test-invocation',
} as InvocationContext;
const runError = new Error('the invocation failed');

describe('PluginManager.runOnRunErrorCallback', () => {
  afterEach(() => {
    notifyOrder.length = 0;
    resetLogger();
  });

  it('notifies every plugin in registration order', async () => {
    const first = new RunErrorPlugin('first');
    const second = new RunErrorPlugin('second');
    const manager = new PluginManager([first, second]);

    await manager.runOnRunErrorCallback({invocationContext, error: runError});

    expect(notifyOrder).toEqual(['first', 'second']);
    expect(first.seen).toEqual([{context: invocationContext, error: runError}]);
    expect(second.seen).toEqual([
      {context: invocationContext, error: runError},
    ]);
  });

  it('notifies the later plugins after an earlier one throws', async () => {
    const failing = new RunErrorPlugin('failing', new Error('plugin boom'));
    const later = new RunErrorPlugin('later');
    const manager = new PluginManager([failing, later]);

    await expect(
      manager.runOnRunErrorCallback({invocationContext, error: runError}),
    ).resolves.toBeUndefined();

    expect(notifyOrder).toEqual(['failing', 'later']);
    expect(later.seen).toHaveLength(1);
  });

  it('logs the plugin that failed instead of rejecting', async () => {
    const manager = new PluginManager([
      new RunErrorPlugin('failing', new Error('plugin boom')),
    ]);
    const errors = recordErrors();

    await manager.runOnRunErrorCallback({invocationContext, error: runError});

    expect(errors).toEqual([
      "Error in plugin 'failing' during 'onRunErrorCallback' callback: plugin boom",
    ]);
  });

  it('resolves for a plugin that does not implement the hook', async () => {
    const manager = new PluginManager([new SilentPlugin('silent')]);

    await expect(
      manager.runOnRunErrorCallback({invocationContext, error: runError}),
    ).resolves.toBeUndefined();
  });

  it('resolves when no plugin is registered', async () => {
    await expect(
      new PluginManager().runOnRunErrorCallback({
        invocationContext,
        error: runError,
      }),
    ).resolves.toBeUndefined();
  });
});
