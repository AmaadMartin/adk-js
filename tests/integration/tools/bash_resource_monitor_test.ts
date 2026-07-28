/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real, un-mocked end-to-end coverage for the best-effort resource monitor.
 *
 * These tests spawn genuine detached process groups and drive the monitor with
 * the real pidtree/pidusage utilities and a real SIGKILL. The standalone
 * monitor is exercised directly (rather than through ExecuteBashTool) because
 * the tool also wraps commands in `ulimit`, which enforces the same limits at
 * the kernel level and would pre-empt the poller on hosts where it is
 * effective. POSIX only; skipped on win32.
 */

import {
  ExecuteBashTool,
  isResourceMonitoringSupported,
  startResourceMonitor,
  type Context,
  type ResourceBreach,
} from '@google/adk';
import {spawn} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const describePosix = isResourceMonitoringSupported()
  ? describe
  : describe.skip;

/** Resolves with the first breach the monitor reports. */
function breachSignal() {
  let report!: (breach: ResourceBreach) => void;
  const breached = new Promise<ResourceBreach>((resolve) => {
    report = resolve;
  });
  return {breached, report};
}

/** Polls until the process group is gone (SIGKILL reaping is asynchronous). */
async function waitForGroupExit(
  pid: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function confirmedContext(): Context {
  return {
    actions: {skipSummarization: false},
    requestConfirmation: () => {},
    toolConfirmation: {confirmed: true},
  } as unknown as Context;
}

const MIB = 1024 * 1024;

describePosix('resource monitor (real processes)', () => {
  let rootPid: number | undefined;

  afterEach(() => {
    if (rootPid !== undefined) {
      try {
        process.kill(-rootPid, 'SIGKILL');
      } catch {
        // Group already gone.
      }
      rootPid = undefined;
    }
  });

  it('kills the process group on a child-process breach', async () => {
    const child = spawn(
      'bash',
      ['-c', 'sleep 30 & sleep 30 & sleep 30 & sleep 30 & wait'],
      {detached: true, stdio: 'ignore'},
    );
    rootPid = child.pid!;
    expect(rootPid).toBeGreaterThan(0);

    const {breached, report} = breachSignal();
    const handle = startResourceMonitor(
      rootPid,
      {maxChildProcesses: 1, intervalMs: 100},
      report,
    );

    const breach = await breached;
    handle.stop();

    expect(breach.reason).toBe('children');
    expect(breach.observed).toBeGreaterThan(1);
    // The whole group must be killed by the monitor.
    expect(await waitForGroupExit(rootPid)).toBe(true);
  }, 20000);

  it('kills the process group on a memory breach', async () => {
    const grow =
      'const held = [];' +
      'setInterval(() => held.push(Buffer.alloc(25 * 1024 * 1024, 1)), 30);';
    const child = spawn(process.execPath, ['-e', grow], {
      detached: true,
      stdio: 'ignore',
    });
    rootPid = child.pid!;
    expect(rootPid).toBeGreaterThan(0);

    const {breached, report} = breachSignal();
    const handle = startResourceMonitor(
      rootPid,
      {maxMemoryBytes: 150 * MIB, intervalMs: 50},
      report,
    );

    const breach = await breached;
    handle.stop();

    expect(breach.reason).toBe('memory');
    expect(breach.observed).toBeGreaterThan(150 * MIB);
    expect(await waitForGroupExit(rootPid)).toBe(true);
  }, 20000);

  it('does not interfere with a command that stays under its limits', async () => {
    const tool = new ExecuteBashTool({
      policy: {
        allowedCommandPrefixes: ['*'],
        enableResourceMonitoring: true,
        maxMemoryBytes: 1024 * MIB,
        maxChildProcesses: 128,
        resourceMonitorIntervalMs: 50,
      },
    });

    const result = (await tool.runAsync({
      args: {command: 'echo monitored'},
      toolContext: confirmedContext(),
    })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain('monitored');
  }, 20000);
});
