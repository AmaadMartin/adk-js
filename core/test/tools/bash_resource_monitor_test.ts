/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_MONITOR_INTERVAL_MS,
  isResourceMonitoringSupported,
  startResourceMonitor,
  type ResourceBreach,
  type ResourceMonitorDeps,
} from '@google/adk';
import * as os from 'node:os';
import pidtree from 'pidtree';
import pidusage from 'pidusage';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  collectProcessTree,
  evaluateUsage,
} from '../../src/tools/bash_resource_monitor.js';
import {logger} from '../../src/utils/logger.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {...actual, platform: vi.fn(actual.platform)};
});
vi.mock('pidtree', () => ({default: vi.fn()}));
vi.mock('pidusage', () => ({default: vi.fn()}));

const ROOT_PID = 4242;

/** Builds a full pidusage Stat object carrying the given RSS in bytes. */
function stat(memory: number) {
  return {cpu: 0, memory, ppid: 0, pid: 0, ctime: 0, elapsed: 0, timestamp: 0};
}

/** A manually resolvable promise, for driving in-flight async ticks. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

describe('isResourceMonitoringSupported', () => {
  afterEach(() => vi.mocked(os.platform).mockReset());

  it('returns true on posix platforms', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    expect(isResourceMonitoringSupported()).toBe(true);
    vi.mocked(os.platform).mockReturnValue('darwin');
    expect(isResourceMonitoringSupported()).toBe(true);
  });

  it('returns false on win32', () => {
    vi.mocked(os.platform).mockReturnValue('win32');
    expect(isResourceMonitoringSupported()).toBe(false);
  });
});

describe('collectProcessTree', () => {
  it('prepends the root and keeps descendants', async () => {
    const list = vi.fn().mockResolvedValue([111, 222]);
    expect(await collectProcessTree(ROOT_PID, list)).toEqual([
      ROOT_PID,
      111,
      222,
    ]);
    expect(list).toHaveBeenCalledWith(ROOT_PID);
  });

  it('de-duplicates the root if the lister also returns it', async () => {
    const list = vi.fn().mockResolvedValue([ROOT_PID, 111]);
    expect(await collectProcessTree(ROOT_PID, list)).toEqual([ROOT_PID, 111]);
  });

  it('returns just the root when there are no descendants', async () => {
    const list = vi.fn().mockResolvedValue([]);
    expect(await collectProcessTree(ROOT_PID, list)).toEqual([ROOT_PID]);
  });
});

describe('evaluateUsage', () => {
  it('flags a memory breach from summed RSS', () => {
    const breach = evaluateUsage(
      [ROOT_PID, 111],
      {[ROOT_PID]: stat(600), '111': stat(700)},
      {maxMemoryBytes: 1000},
    );
    expect(breach).toEqual({reason: 'memory', limit: 1000, observed: 1300});
  });

  it('treats missing usage entries as zero RSS', () => {
    const breach = evaluateUsage(
      [ROOT_PID, 111],
      {[ROOT_PID]: stat(400)},
      {maxMemoryBytes: 1000},
    );
    expect(breach).toBeNull();
  });

  it('does not breach at the exact memory boundary (strictly >)', () => {
    expect(
      evaluateUsage(
        [ROOT_PID],
        {[ROOT_PID]: stat(1000)},
        {maxMemoryBytes: 1000},
      ),
    ).toBeNull();
  });

  it('flags a children breach from the descendant count', () => {
    const breach = evaluateUsage(
      [ROOT_PID, 1, 2, 3],
      {},
      {maxChildProcesses: 2},
    );
    expect(breach).toEqual({reason: 'children', limit: 2, observed: 3});
  });

  it('does not breach at the exact children boundary (strictly >)', () => {
    expect(
      evaluateUsage([ROOT_PID, 1, 2], {}, {maxChildProcesses: 2}),
    ).toBeNull();
  });

  it('checks memory before children when both would breach', () => {
    const breach = evaluateUsage(
      [ROOT_PID, 1, 2, 3],
      {[ROOT_PID]: stat(5000)},
      {maxMemoryBytes: 1000, maxChildProcesses: 1},
    );
    expect(breach?.reason).toBe('memory');
  });

  it('returns null when under all configured limits', () => {
    expect(
      evaluateUsage(
        [ROOT_PID, 1],
        {[ROOT_PID]: stat(10)},
        {maxMemoryBytes: 1000, maxChildProcesses: 5},
      ),
    ).toBeNull();
  });

  it('returns null when no limits are configured', () => {
    expect(evaluateUsage([ROOT_PID, 1, 2], {}, {})).toBeNull();
  });
});

describe('startResourceMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(pidtree).mockReset();
    vi.mocked(pidusage).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes the default polling interval', () => {
    expect(DEFAULT_MONITOR_INTERVAL_MS).toBe(250);
  });

  it('returns a no-op handle on win32', async () => {
    vi.mocked(os.platform).mockReturnValue('win32');
    const deps: Required<ResourceMonitorDeps> = {
      listProcessTree: vi.fn().mockResolvedValue([1]),
      sampleUsage: vi.fn().mockResolvedValue({}),
      killGroup: vi.fn(),
    };
    const onBreach = vi.fn();
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 1},
      onBreach,
      deps,
    );

    await vi.advanceTimersByTimeAsync(5000);

    expect(handle.breach).toBeNull();
    expect(deps.listProcessTree).not.toHaveBeenCalled();
    expect(deps.killGroup).not.toHaveBeenCalled();
    expect(onBreach).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it('returns a no-op handle when no limits are set', async () => {
    const deps: Required<ResourceMonitorDeps> = {
      listProcessTree: vi.fn().mockResolvedValue([1]),
      sampleUsage: vi.fn().mockResolvedValue({}),
      killGroup: vi.fn(),
    };
    const handle = startResourceMonitor(ROOT_PID, {}, vi.fn(), deps);

    await vi.advanceTimersByTimeAsync(5000);

    expect(handle.breach).toBeNull();
    expect(deps.listProcessTree).not.toHaveBeenCalled();
  });

  it('kills the group and reports a memory breach', async () => {
    const killGroup = vi.fn();
    const onBreach = vi.fn();
    const deps: ResourceMonitorDeps = {
      listProcessTree: vi.fn().mockResolvedValue([111, 222]),
      sampleUsage: vi.fn().mockResolvedValue({
        [ROOT_PID]: {memory: 600},
        '111': {memory: 700},
      }),
      killGroup,
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 1000, intervalMs: 100},
      onBreach,
      deps,
    );

    await vi.advanceTimersByTimeAsync(100);

    const expected: ResourceBreach = {
      reason: 'memory',
      limit: 1000,
      observed: 1300,
    };
    expect(killGroup).toHaveBeenCalledOnce();
    expect(killGroup).toHaveBeenCalledWith(ROOT_PID);
    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith(expected);
    expect(handle.breach).toEqual(expected);

    // The monitor has stopped; further ticks do nothing.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onBreach).toHaveBeenCalledOnce();
    expect(killGroup).toHaveBeenCalledOnce();
  });

  it('kills the group and reports a children breach', async () => {
    const killGroup = vi.fn();
    const onBreach = vi.fn();
    const deps: ResourceMonitorDeps = {
      listProcessTree: vi.fn().mockResolvedValue([1, 2, 3]),
      sampleUsage: vi.fn().mockResolvedValue({}),
      killGroup,
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxChildProcesses: 2, intervalMs: 100},
      onBreach,
      deps,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(onBreach).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledWith({
      reason: 'children',
      limit: 2,
      observed: 3,
    });
    expect(killGroup).toHaveBeenCalledOnce();
    expect(killGroup).toHaveBeenCalledWith(ROOT_PID);
    expect(handle.breach?.reason).toBe('children');
  });

  it('still reports the breach when killing the group throws', async () => {
    const killGroup = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const onBreach = vi.fn();
    const deps: ResourceMonitorDeps = {
      listProcessTree: vi.fn().mockResolvedValue([]),
      sampleUsage: vi.fn().mockResolvedValue({[ROOT_PID]: {memory: 5000}}),
      killGroup,
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 1000, intervalMs: 100},
      onBreach,
      deps,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(killGroup).toHaveBeenCalledOnce();
    expect(onBreach).toHaveBeenCalledOnce();
    expect(handle.breach?.reason).toBe('memory');
  });

  it('keeps polling across ticks while under limits, using the default interval', async () => {
    const listProcessTree = vi.fn().mockResolvedValue([111]);
    const onBreach = vi.fn();
    const deps: ResourceMonitorDeps = {
      listProcessTree,
      sampleUsage: vi.fn().mockResolvedValue({[ROOT_PID]: {memory: 10}}),
      killGroup: vi.fn(),
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 100_000},
      onBreach,
      deps,
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_MONITOR_INTERVAL_MS * 3);

    expect(onBreach).not.toHaveBeenCalled();
    expect(listProcessTree.mock.calls.length).toBeGreaterThanOrEqual(3);
    handle.stop();
  });

  it('stops polling after stop() and is idempotent', async () => {
    const listProcessTree = vi.fn().mockResolvedValue([111]);
    const deps: ResourceMonitorDeps = {
      listProcessTree,
      sampleUsage: vi.fn().mockResolvedValue({[ROOT_PID]: {memory: 10}}),
      killGroup: vi.fn(),
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 100_000, intervalMs: 100},
      vi.fn(),
      deps,
    );

    await vi.advanceTimersByTimeAsync(100);
    const callsAfterFirstTick = listProcessTree.mock.calls.length;
    handle.stop();

    await vi.advanceTimersByTimeAsync(1000);
    expect(listProcessTree.mock.calls.length).toBe(callsAfterFirstTick);
    expect(() => handle.stop()).not.toThrow();
    expect(handle.breach).toBeNull();
  });

  it('stops quietly when the process tree is already gone', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    const killGroup = vi.fn();
    const listProcessTree = vi.fn().mockRejectedValue(new Error('ESRCH'));
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 1000, intervalMs: 100},
      vi.fn(),
      {listProcessTree, sampleUsage: vi.fn(), killGroup},
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(debugSpy).toHaveBeenCalledOnce();
    expect(killGroup).not.toHaveBeenCalled();
    expect(handle.breach).toBeNull();

    // Monitor is stopped: no further polling.
    await vi.advanceTimersByTimeAsync(1000);
    expect(listProcessTree).toHaveBeenCalledOnce();
  });

  it('does not overlap ticks while a sample is in flight', async () => {
    const sample = deferred<Record<string, {memory: number}>>();
    const sampleUsage = vi.fn().mockReturnValue(sample.promise);
    const deps: ResourceMonitorDeps = {
      listProcessTree: vi.fn().mockResolvedValue([111]),
      sampleUsage,
      killGroup: vi.fn(),
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 100_000, intervalMs: 100},
      vi.fn(),
      deps,
    );

    // Tick 1 starts and blocks awaiting the sample.
    await vi.advanceTimersByTimeAsync(100);
    // Tick 2 fires but bails out because tick 1 is still running.
    await vi.advanceTimersByTimeAsync(100);
    expect(sampleUsage).toHaveBeenCalledOnce();

    sample.resolve({[ROOT_PID]: {memory: 10}});
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
  });

  it('does not kill the group when stopped mid-tick', async () => {
    const sample = deferred<Record<string, {memory: number}>>();
    const killGroup = vi.fn();
    const onBreach = vi.fn();
    const deps: ResourceMonitorDeps = {
      listProcessTree: vi.fn().mockResolvedValue([]),
      sampleUsage: vi.fn().mockReturnValue(sample.promise),
      killGroup,
    };
    const handle = startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 100, intervalMs: 100},
      onBreach,
      deps,
    );

    await vi.advanceTimersByTimeAsync(100);
    handle.stop();
    // The sample resolves over-limit, but the monitor was already stopped.
    sample.resolve({[ROOT_PID]: {memory: 5000}});
    await vi.advanceTimersByTimeAsync(0);

    expect(killGroup).not.toHaveBeenCalled();
    expect(onBreach).not.toHaveBeenCalled();
    expect(handle.breach).toBeNull();
  });

  it('falls back to pidtree, pidusage and process.kill when no deps are given', async () => {
    // pidtree is overloaded; select the Promise<number[]> signature for mocking.
    vi.mocked(pidtree as (pid: number) => Promise<number[]>).mockResolvedValue([
      999,
    ]);
    vi.mocked(pidusage).mockResolvedValue({
      [ROOT_PID]: stat(5000),
      '999': stat(6000),
    });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const onBreach = vi.fn();

    startResourceMonitor(
      ROOT_PID,
      {maxMemoryBytes: 1000, intervalMs: 100},
      onBreach,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(pidtree).toHaveBeenCalledWith(ROOT_PID);
    expect(pidusage).toHaveBeenCalledWith([ROOT_PID, 999]);
    expect(killSpy).toHaveBeenCalledWith(-ROOT_PID, 'SIGKILL');
    expect(onBreach).toHaveBeenCalledOnce();
  });
});
