/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `workflow_node_parallel` sample (offline) through a full
 * `InMemoryRunner`: a `WorkflowNode` subclass with `parallelWorker: true` maps
 * itself over the list its predecessor produced, keeping its own field on every
 * item.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: workflow_node_parallel', () => {
  it('maps the subclass over the produced list and keeps its own field', async () => {
    const perTurn = await runSample({
      name: 'workflow_node_parallel',
      rootAgent,
      turns: ['ships, sealing wax, cabbages'],
      offline: true,
    });
    const events = allEvents(perTurn);

    expect(authors(events).has('summarize')).toBe(true);

    const outputsOf = (author: string) =>
      events
        .filter((e) => e.author === author && e.output !== undefined)
        .map((e) => e.output);

    expect(outputsOf('split_topics')).toEqual([
      ['ships', 'sealing wax', 'cabbages'],
    ]);

    // Each item emits its own event under the node's name; the ordered list is
    // the node's own output. Item events arrive in completion order.
    const summarized = outputsOf('summarize');
    expect(summarized.filter((o) => typeof o === 'string').sort()).toEqual([
      'terse: cabbages',
      'terse: sealing wax',
      'terse: ships',
    ]);
    expect(summarized.filter(Array.isArray)).toEqual([
      ['terse: ships', 'terse: sealing wax', 'terse: cabbages'],
    ]);

    expect(outputsOf('join_lines')).toEqual([
      'terse: ships\nterse: sealing wax\nterse: cabbages',
    ]);
  });
});
