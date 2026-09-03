/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createLinkedAbort} from '@google/adk';
import {describe, expect, it} from 'vitest';

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createLinkedAbort', () => {
  it('does not abort on its own', async () => {
    const linked = createLinkedAbort();

    await tick(5);

    expect(linked.controller.signal.aborted).toBe(false);
    linked.dispose();
  });

  it('aborts once the timeout elapses', async () => {
    const linked = createLinkedAbort(undefined, 1);

    await tick(10);

    expect(linked.controller.signal.aborted).toBe(true);
    linked.dispose();
  });

  it('aborts when the parent signal aborts', () => {
    const parent = new AbortController();
    const linked = createLinkedAbort(parent.signal);

    parent.abort();

    expect(linked.controller.signal.aborted).toBe(true);
    linked.dispose();
  });

  it('starts aborted when the parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort();

    const linked = createLinkedAbort(parent.signal, 1000);

    expect(linked.controller.signal.aborted).toBe(true);
    linked.dispose();
  });

  it('stops following the parent after dispose', () => {
    const parent = new AbortController();
    const linked = createLinkedAbort(parent.signal);

    linked.dispose();
    parent.abort();

    expect(linked.controller.signal.aborted).toBe(false);
  });

  it('cancels the deadline on dispose', async () => {
    const linked = createLinkedAbort(undefined, 1);

    linked.dispose();
    await tick(10);

    expect(linked.controller.signal.aborted).toBe(false);
  });

  it('cancels the deadline on dispose when a parent is set', async () => {
    const parent = new AbortController();
    const linked = createLinkedAbort(parent.signal, 1);

    linked.dispose();
    await tick(10);

    expect(linked.controller.signal.aborted).toBe(false);
  });
});
