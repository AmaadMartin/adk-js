/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chronological sequence barrier for deterministic replay ordering.
 *
 * Ported from `google/adk-python`
 * `workflow/utils/_replay_sequence_barrier.py`.
 */

/** How long a replayed key waits for its turn before the replay is declared divergent. */
const DEFAULT_REPLAY_TIMEOUT_MS = 15_000;

/** A one-way latch: it starts closed, opens once, and never closes again. */
interface Gate {
  readonly opened: Promise<void>;
  isOpen: boolean;
  open(): void;
}

function createGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate: Gate = {
    opened,
    isOpen: false,
    open() {
      gate.isOpen = true;
      release();
    },
  };
  return gate;
}

/**
 * Releases replayed node completions in the order history recorded them.
 *
 * A resumed workflow fast-forwards the nodes that already finished. Those
 * fast-forwards settle in whatever order their promises happen to resolve,
 * which for parallel branches is not the order the original run completed in.
 * The barrier holds each replayed key until the key before it in the recorded
 * sequence has completed, so the resumed run reproduces the recorded order.
 *
 * A key the sequence does not name is not replayed, so it never waits.
 */
export class ReplaySequenceBarrier {
  /** The recorded completion order, as `<nodeName>@<runId>` keys. */
  readonly sequence: readonly string[];

  private readonly timeoutMs: number;
  private readonly gates = new Map<string, Gate>();
  private cursor = 0;

  constructor(
    sequence: readonly string[],
    timeoutMs: number = DEFAULT_REPLAY_TIMEOUT_MS,
  ) {
    this.sequence = [...sequence];
    this.timeoutMs = timeoutMs;
    for (const key of this.sequence) {
      this.gates.set(key, createGate());
    }
    if (this.sequence.length > 0) {
      this.gates.get(this.sequence[0])!.open();
    }
  }

  /** How far through {@link sequence} the replay has advanced. */
  get currentIndex(): number {
    return this.cursor;
  }

  /** Whether `key`'s gate is open, so a waiter on it would pass straight through. */
  isOpen(key: string): boolean {
    return this.gates.get(key)?.isOpen === true;
  }

  /**
   * Waits for `key`'s turn in the recorded sequence.
   *
   * Resolves immediately for a key the sequence does not name: a node that
   * only emitted state updates produced no terminal event, so it is not part
   * of the recorded order and must not block on it.
   *
   * @throws Error when the key does not come up within the timeout, which
   *     means the resumed graph diverged from the recorded one.
   */
  async wait(key: string): Promise<void> {
    const gate = this.gates.get(key);
    if (!gate) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Replay divergence detected: Timed out waiting for sequence ` +
                `key '${key}' to be unblocked.`,
            ),
          ),
        this.timeoutMs,
      );
    });
    return Promise.race([gate.opened, timedOut]).finally(() =>
      clearTimeout(timer),
    );
  }

  /**
   * Records that `key` completed, releasing the next key when it was the one
   * the sequence expected. A key that arrives out of order is ignored: it is
   * either a fresh execution the recording does not know about, or a
   * completion the sequence still expects later.
   */
  checkAndAdvance(key: string): void {
    if (key !== this.sequence[this.cursor]) {
      return;
    }
    this.cursor += 1;
    const next = this.sequence[this.cursor];
    if (next !== undefined) {
      this.gates.get(next)!.open();
    }
  }

  /**
   * Releases every waiter, for a run shutting down.
   *
   * A replay divergence rejects one waiter and tears the workflow down, but
   * the others are still parked on gates nothing will open now. Opening them
   * lets their timeouts clear and lets the shutdown await them.
   */
  dispose(): void {
    for (const gate of this.gates.values()) {
      gate.open();
    }
  }
}
