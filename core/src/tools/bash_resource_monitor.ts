/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import pidtree from 'pidtree';
import pidusage from 'pidusage';
import {logger} from '../utils/logger.js';

/** Default polling interval, in milliseconds. */
export const DEFAULT_MONITOR_INTERVAL_MS = 250;

/** Which resource limit was breached. */
export type ResourceBreachReason = 'memory' | 'children';

/** Details of a detected breach (observed value vs. configured limit). */
export interface ResourceBreach {
  reason: ResourceBreachReason;
  /** Configured limit: bytes for memory, process count for children. */
  limit: number;
  /** Observed value at breach time. */
  observed: number;
}

/** Policy consumed by the monitor (subset of BashToolPolicy plus interval). */
export interface ResourceMonitorPolicy {
  maxMemoryBytes?: number;
  maxChildProcesses?: number;
  /** Poll interval in ms; defaults to DEFAULT_MONITOR_INTERVAL_MS. */
  intervalMs?: number;
}

/** Handle returned by startResourceMonitor. */
export interface ResourceMonitorHandle {
  /** Stops polling and releases the timer. Idempotent. */
  stop(): void;
  /** The breach that fired (and killed the group), or null if none. */
  readonly breach: ResourceBreach | null;
}

/** Injectable seams for deterministic unit testing (all optional). */
export interface ResourceMonitorDeps {
  /** Enumerate descendant PIDs of the given PID. Defaults to pidtree. */
  listProcessTree?: (pid: number) => Promise<number[]>;
  /** Sample per-PID memory (RSS) in bytes. Defaults to pidusage. */
  sampleUsage?: (pids: number[]) => Promise<Record<string, {memory: number}>>;
  /** SIGKILL the process group led by the PID. Defaults to process.kill. */
  killGroup?: (pid: number) => void;
}

/** Returns whether active resource monitoring is supported (POSIX only). */
export function isResourceMonitoringSupported(): boolean {
  return os.platform() !== 'win32';
}

function defaultKillGroup(pid: number): void {
  process.kill(-pid, 'SIGKILL');
}

/**
 * Returns `[pid, ...descendants]` with the root PID de-duplicated. Rejections
 * (e.g. the process already exited) propagate to the caller.
 */
export async function collectProcessTree(
  pid: number,
  listProcessTree: (pid: number) => Promise<number[]>,
): Promise<number[]> {
  const descendants = await listProcessTree(pid);
  return [pid, ...descendants.filter((p) => p !== pid)];
}

/**
 * Pure evaluation of a usage snapshot against the policy. Sums RSS across the
 * tree (missing entries count as 0) and counts descendants as
 * `pids.length - 1`. Memory is checked before children; returns the first
 * breach, or null when under all limits.
 */
export function evaluateUsage(
  pids: number[],
  usage: Record<string, {memory: number}>,
  policy: ResourceMonitorPolicy,
): ResourceBreach | null {
  if (policy.maxMemoryBytes !== undefined) {
    let observed = 0;
    for (const pid of pids) {
      observed += usage[pid]?.memory ?? 0;
    }
    if (observed > policy.maxMemoryBytes) {
      return {reason: 'memory', limit: policy.maxMemoryBytes, observed};
    }
  }
  if (policy.maxChildProcesses !== undefined) {
    const observed = pids.length - 1;
    if (observed > policy.maxChildProcesses) {
      return {reason: 'children', limit: policy.maxChildProcesses, observed};
    }
  }
  return null;
}

/**
 * Starts a best-effort resource monitor for the process group led by `pid`.
 *
 * Returns a no-op handle when monitoring is unsupported (non-POSIX) or when
 * neither `maxMemoryBytes` nor `maxChildProcesses` is set. Otherwise polls the
 * process tree; on the first breach it SIGKILLs the process group, records the
 * breach, stops polling, and invokes `onBreach` exactly once. Ticks that throw
 * (e.g. the process already exited) stop the monitor quietly.
 */
export function startResourceMonitor(
  pid: number,
  policy: ResourceMonitorPolicy,
  onBreach: (breach: ResourceBreach) => void,
  deps: ResourceMonitorDeps = {},
): ResourceMonitorHandle {
  if (
    !isResourceMonitoringSupported() ||
    (policy.maxMemoryBytes === undefined &&
      policy.maxChildProcesses === undefined)
  ) {
    return {stop() {}, breach: null};
  }

  const listProcessTree = deps.listProcessTree ?? ((p) => pidtree(p));
  const sampleUsage = deps.sampleUsage ?? ((pids) => pidusage(pids));
  const killGroup = deps.killGroup ?? defaultKillGroup;

  let stopped = false;
  let ticking = false;
  let breach: ResourceBreach | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const pids = await collectProcessTree(pid, listProcessTree);
      const usage = await sampleUsage(pids);
      const detected = evaluateUsage(pids, usage, policy);
      if (detected !== null && !stopped) {
        try {
          killGroup(pid);
        } catch (_e) {
          // The group may have already exited; nothing to kill.
        }
        breach = detected;
        stop();
        onBreach(detected);
      }
    } catch (e) {
      logger.debug(`Resource monitor for pid ${pid} stopping: ${e}`);
      stop();
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, policy.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS);

  return {
    stop,
    get breach() {
      return breach;
    },
  };
}
