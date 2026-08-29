/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FunctionTool,
  SyncCallableRunner,
  runWithSyncCallableRunner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

const emptyContext = {} as Context;

/** A runner that records every offloaded call and defers it a turn. */
function recordingRunner(): {runner: SyncCallableRunner; calls: number} {
  const record = {
    calls: 0,
    runner: async (call: () => unknown) => {
      record.calls++;
      await new Promise((resolve) => setImmediate(resolve));
      return call();
    },
  };
  return record;
}

function syncTool(name: string, execute: () => unknown): FunctionTool {
  return new FunctionTool({name, description: `Runs ${name}.`, execute});
}

describe('sync callable runner', () => {
  it('runs a sync execute inline when no runner is bound', async () => {
    const tool = syncTool('inline', () => 'done');

    await expect(
      tool.runAsync({args: {}, toolContext: emptyContext}),
    ).resolves.toBe('done');
  });

  it('routes a sync execute through the bound runner', async () => {
    const record = recordingRunner();
    const tool = syncTool('offloaded', () => 'body');

    const result = await runWithSyncCallableRunner(
      async (call) => `wrapped:${await record.runner(call)}`,
      () => tool.runAsync({args: {}, toolContext: emptyContext}),
    );

    expect(result).toBe('wrapped:body');
    expect(record.calls).toBe(1);
  });

  it('does not route an async execute through the runner', async () => {
    const record = recordingRunner();
    const tool = new FunctionTool({
      name: 'async_body',
      description: 'Runs asynchronously.',
      execute: async () => 'body',
    });

    const result = await runWithSyncCallableRunner(record.runner, () =>
      tool.runAsync({args: {}, toolContext: emptyContext}),
    );

    expect(result).toBe('body');
    expect(record.calls).toBe(0);
  });

  it('does not route an async generator execute through the runner', async () => {
    const record = recordingRunner();
    const tool = new FunctionTool({
      name: 'streaming_body',
      description: 'Yields values.',
      execute: async function* () {
        yield 'first';
      },
    });

    const result = await runWithSyncCallableRunner(record.runner, () =>
      tool.runAsync({args: {}, toolContext: emptyContext}),
    );

    expect(record.calls).toBe(0);
    const generator = result as AsyncGenerator<string>;
    await expect(generator.next()).resolves.toEqual({
      value: 'first',
      done: false,
    });
  });

  it('runs a nested tool call inline instead of offloading it again', async () => {
    const record = recordingRunner();
    const inner = syncTool('inner', () => 'inner result');
    const outer = syncTool('outer', () =>
      inner.runAsync({args: {}, toolContext: emptyContext}),
    );

    const result = await runWithSyncCallableRunner(record.runner, () =>
      outer.runAsync({args: {}, toolContext: emptyContext}),
    );

    expect(await result).toBe('inner result');
    expect(record.calls).toBe(1);
  });

  it('validates arguments before the runner sees the call', async () => {
    const record = recordingRunner();
    const tool = new FunctionTool({
      name: 'strict',
      description: 'Needs a number.',
      parameters: z.object({count: z.number()}),
      execute: ({count}) => count,
    });

    await expect(
      runWithSyncCallableRunner(record.runner, () =>
        tool.runAsync({args: {count: 'nope'}, toolContext: emptyContext}),
      ),
    ).rejects.toThrow("Error in tool 'strict'");
    expect(record.calls).toBe(0);
  });

  it("reports a runner rejection as the tool's error", async () => {
    const tool = syncTool('failing', () => 'never reached');

    await expect(
      runWithSyncCallableRunner(
        () => Promise.reject(new Error('worker pool is full')),
        () => tool.runAsync({args: {}, toolContext: emptyContext}),
      ),
    ).rejects.toThrow("Error in tool 'failing': worker pool is full");
  });

  it('restores the previous binding after the callback returns', async () => {
    const outerRecord = recordingRunner();
    const innerRecord = recordingRunner();
    const tool = syncTool('probe', () => 'body');

    await runWithSyncCallableRunner(outerRecord.runner, async () => {
      await runWithSyncCallableRunner(innerRecord.runner, () =>
        tool.runAsync({args: {}, toolContext: emptyContext}),
      );
      await tool.runAsync({args: {}, toolContext: emptyContext});
    });

    expect(innerRecord.calls).toBe(1);
    expect(outerRecord.calls).toBe(1);
  });

  it('restores the previous binding after the callback throws', async () => {
    const outerRecord = recordingRunner();
    const tool = syncTool('probe', () => 'body');

    await runWithSyncCallableRunner(outerRecord.runner, async () => {
      expect(() =>
        runWithSyncCallableRunner(recordingRunner().runner, () => {
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
      await tool.runAsync({args: {}, toolContext: emptyContext});
    });

    expect(outerRecord.calls).toBe(1);
  });

  it('keeps concurrent calls on their own binding', async () => {
    const record = recordingRunner();
    const tool = syncTool('probe', () => 'body');

    const bound = runWithSyncCallableRunner(record.runner, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return tool.runAsync({args: {}, toolContext: emptyContext});
    });
    const unbound = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return tool.runAsync({args: {}, toolContext: emptyContext});
    })();

    await expect(Promise.all([bound, unbound])).resolves.toEqual([
      'body',
      'body',
    ]);
    expect(record.calls).toBe(1);
  });
});
