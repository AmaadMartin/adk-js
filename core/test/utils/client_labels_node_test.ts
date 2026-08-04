/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getClientLabels, runWithClientLabel} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {installNodeClientLabelStore} from '../../src/utils/client_labels_node.js';

/** Reads the label that `runWithClientLabel` put in the current context. */
function currentContextLabel(): string | undefined {
  return getClientLabels().find((label) => label.startsWith('task-'));
}

describe('client_labels_node', () => {
  beforeEach(() => {
    installNodeClientLabelStore();
  });

  it('keeps the label across an await', async () => {
    const seen = await runWithClientLabel('task-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentContextLabel();
    });

    expect(seen).toBe('task-a');
  });

  it('isolates the labels of concurrent invocations', async () => {
    const run = (label: string, delayMs: number) =>
      runWithClientLabel(label, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return currentContextLabel();
      });

    await expect(
      Promise.all([run('task-a', 20), run('task-b', 5)]),
    ).resolves.toEqual(['task-a', 'task-b']);
  });
});
