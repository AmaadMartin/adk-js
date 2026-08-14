/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A gate-per-key barrier over a recorded completion sequence, so a resumed
 * workflow replays its nodes in the order the session already records.
 *
 * Ported from `google/adk-python`
 * `workflow/utils/_replay_sequence_barrier.py`.
 */

import {ReplayDivergenceError} from '../errors.js';

/**
 * Deadline for a replayed node awaiting its turn. Parity with the Python
 * barrier's `timeout_sec = 15.0`.
 */
const DEFAULT_REPLAY_TIMEOUT_MS = 15_000;

/** A one-way gate: shut until {@link open}, then open forever. */
class Gate {
  opened = false;
  private readonly waiters: Array<() => void> = [];

  /** Resolves when the gate opens. Only called while the gate is shut. */
  waitForOpen(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  open(): void {
    this.opened = true;
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters.length = 0;
  }
}

/**
 * Holds every recorded completion but the next one shut, so a replayed turn
 * reproduces the order the session records instead of the order the scheduler
 * happens to produce.
 *
 * A key outside the sequence never blocks: a node that emitted no terminal
 * event was never part of the recorded order, and neither is a node running for
 * the first time.
 */
export class ReplaySequenceBarrier {
  /** The recorded completion order, as barrier keys. */
  readonly sequence: readonly string[];

  private readonly gates = new Map<string, Gate>();
  private readonly timeoutMs: number;
  private index = 0;

  /**
   * @param sequence The recorded completion order, as barrier keys.
   * @param timeoutMs How long {@link wait} waits before declaring divergence.
   */
  constructor(
    sequence: readonly string[],
    timeoutMs: number = DEFAULT_REPLAY_TIMEOUT_MS,
  ) {
    this.sequence = [...sequence];
    this.timeoutMs = timeoutMs;
    for (const key of this.sequence) {
      if (!this.gates.has(key)) {
        this.gates.set(key, new Gate());
      }
    }
    if (this.sequence.length > 0) {
      this.gates.get(this.sequence[0])!.open();
    }
  }

  /** Index of the key the recording expects to complete next. */
  get currentIndex(): number {
    return this.index;
  }

  /** Whether `key`'s gate is open (a key outside the sequence is always open). */
  isOpen(key: string): boolean {
    const gate = this.gates.get(key);
    return gate === undefined || gate.opened;
  }

  /**
   * Resolves once `key`'s gate is open, or rejects with
   * {@link ReplayDivergenceError} once the deadline passes.
   */
  async wait(key: string): Promise<void> {
    const gate = this.gates.get(key);
    if (gate === undefined || gate.opened) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gate.waitForOpen(),
        // Never resolves, so the race is settled by the gate or by the
        // deadline. The timer is cleared on both exits.
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new ReplayDivergenceError({
                sequenceKey: key,
                timeoutMs: this.timeoutMs,
              }),
            );
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Opens the next gate if `key` is the completion the recording expects next. */
  checkAndAdvance(key: string): void {
    if (
      this.index >= this.sequence.length ||
      key !== this.sequence[this.index]
    ) {
      return;
    }
    this.index += 1;
    if (this.index < this.sequence.length) {
      this.gates.get(this.sequence[this.index])!.open();
    }
  }
}
