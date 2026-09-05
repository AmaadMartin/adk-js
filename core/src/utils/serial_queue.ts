/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A promise-chain serializer keyed by string.
 *
 * Work submitted under the same key runs one item at a time, in submission
 * order. Work under different keys runs concurrently. The queue holds one
 * entry per key that has work in flight, and drops the entry once the last
 * item settles, so it does not grow for the life of the process.
 */

function ignore(): void {}

/**
 * Runs `work` after every item already queued under `key`.
 *
 * @param queue The queue state. Create one `Map` per group of related work
 *   and pass the same one on every call.
 * @param key Items sharing a key run one at a time.
 * @param work The work to run. Its result, including a rejection, is returned
 *   to the caller and never leaks into the next item.
 * @return What `work` resolves to.
 */
export function runSerialized<T>(
  queue: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const queued = queue.get(key);
  const result = queued ? queued.then(work) : work();

  // The queued promise must never reject, or one failure would fail every
  // item waiting behind it.
  const settled = result.then(ignore, ignore);
  queue.set(key, settled);
  void settled.then(() => {
    // Drop the entry only when nothing queued behind this item, so the queue
    // does not keep one entry per key forever.
    if (queue.get(key) === settled) {
      queue.delete(key);
    }
  });
  return result;
}
