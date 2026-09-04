/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `tests/unittests/plugins/test_notification_error_callbacks.py`
 * in `google/adk-python`, at `main`.
 *
 * | Test below | Reference test |
 * | --- | --- |
 * | notifies every registered plugin | `test_run_on_run_error_callback_dispatches` |
 * | notifies a later plugin after an earlier one returns | `test_run_error_callback_does_not_short_circuit` |
 * | keeps going when a plugin throws | `test_plugin_callback_failure_does_not_mask_app_error` |
 *
 * The reference short-circuit test has its plugin return a value, which the
 * manager must ignore. `onRunErrorCallback` resolves to `void` here, so
 * TypeScript rejects a plugin that returns one. The test below keeps the half
 * that survives the type system: a later plugin still hears about the error.
 */

import {
  BasePlugin,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

import {resetLogger, setLogger} from '../../src/utils/logger.js';

/** Records every run error the manager reported to it. */
class ErrorTrackingPlugin extends BasePlugin {
  readonly runErrors: Array<{
    invocationContext: InvocationContext;
    error: Error;
  }> = [];

  override async onRunErrorCallback(params: {
    invocationContext: InvocationContext;
    error: Error;
  }): Promise<void> {
    this.runErrors.push(params);
  }
}

/** Records the order in which the manager notified the plugins. */
const notifyOrder: string[] = [];

/** Completes normally, and records that it was notified. */
class QuietPlugin extends BasePlugin {
  override async onRunErrorCallback(): Promise<void> {
    notifyOrder.push(this.name);
  }
}

/** Leaves `onRunErrorCallback` at its default, so the base body runs. */
class IndifferentPlugin extends BasePlugin {}

/** Fails while being told about the run error. */
class FailingPlugin extends BasePlugin {
  notified = false;

  override async onRunErrorCallback(): Promise<void> {
    this.notified = true;
    throw new Error('plugin boom');
  }
}

function createContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'quiet_agent'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });
}

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

describe('PluginManager.runOnRunErrorCallback', () => {
  afterEach(() => {
    notifyOrder.length = 0;
    resetLogger();
  });

  it('notifies every registered plugin', async () => {
    const first = new ErrorTrackingPlugin('p1');
    const second = new ErrorTrackingPlugin('p2');
    const manager = new PluginManager([first, second]);
    const invocationContext = createContext();
    const error = new Error('boom');

    await manager.runOnRunErrorCallback({invocationContext, error});

    expect(first.runErrors).toHaveLength(1);
    expect(second.runErrors).toHaveLength(1);
    expect(first.runErrors[0].error).toBe(error);
    expect(first.runErrors[0].invocationContext).toBe(invocationContext);
    expect(second.runErrors[0].error).toBe(error);
    expect(second.runErrors[0].invocationContext).toBe(invocationContext);
  });

  it('notifies a later plugin after an earlier one returns', async () => {
    const manager = new PluginManager([
      new QuietPlugin('p1'),
      new QuietPlugin('p2'),
      new QuietPlugin('p3'),
    ]);

    await manager.runOnRunErrorCallback({
      invocationContext: createContext(),
      error: new Error('boom'),
    });

    expect(notifyOrder).toEqual(['p1', 'p2', 'p3']);
  });

  it('keeps going when a plugin throws', async () => {
    const failing = new FailingPlugin('p1');
    const tracking = new ErrorTrackingPlugin('p2');
    const manager = new PluginManager([failing, tracking]);

    await expect(
      manager.runOnRunErrorCallback({
        invocationContext: createContext(),
        error: new Error('app crash'),
      }),
    ).resolves.toBeUndefined();

    expect(failing.notified).toBe(true);
    expect(tracking.runErrors).toHaveLength(1);
  });

  it('resolves when every plugin throws', async () => {
    const first = new FailingPlugin('p1');
    const second = new FailingPlugin('p2');
    const manager = new PluginManager([first, second]);

    await expect(
      manager.runOnRunErrorCallback({
        invocationContext: createContext(),
        error: new Error('app crash'),
      }),
    ).resolves.toBeUndefined();

    expect(first.notified).toBe(true);
    expect(second.notified).toBe(true);
  });

  it('logs the plugin that failed instead of rejecting', async () => {
    const manager = new PluginManager([new FailingPlugin('p1')]);
    const errors = recordErrors();

    await manager.runOnRunErrorCallback({
      invocationContext: createContext(),
      error: new Error('app crash'),
    });

    expect(errors).toEqual([
      "Error in plugin 'p1' during 'onRunErrorCallback' callback: plugin boom",
    ]);
  });

  it('resolves for a plugin that does not override the hook', async () => {
    const manager = new PluginManager([new IndifferentPlugin('p1')]);

    await expect(
      manager.runOnRunErrorCallback({
        invocationContext: createContext(),
        error: new Error('boom'),
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves when no plugin is registered', async () => {
    await expect(
      new PluginManager().runOnRunErrorCallback({
        invocationContext: createContext(),
        error: new Error('boom'),
      }),
    ).resolves.toBeUndefined();
  });
});
