/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createNodeState} from '../../src/workflow/node_state.js';
import {NodeStatus} from '../../src/workflow/node_status.js';
import {
  buildWorkflowAgentState,
  createEndOfAgentEvent,
  createNodeCheckpointEvent,
  createReplayedOutputEvent,
} from '../../src/workflow/utils/checkpoint_utils.js';

const origin = {author: 'wf', invocationId: 'inv-1', branch: 'b1'};

describe('buildWorkflowAgentState', () => {
  it('keeps only the status and the pending interrupts', () => {
    const nodes = new Map([
      [
        'gate',
        createNodeState({
          status: NodeStatus.WAITING,
          interrupts: ['i1'],
          resumeInputs: {i1: {accessToken: 'secret'}},
          input: 'the input',
          runId: '1',
        }),
      ],
    ]);

    expect(buildWorkflowAgentState(nodes)).toEqual({
      nodes: {gate: {status: NodeStatus.WAITING, interrupts: ['i1']}},
    });
  });

  it('copies the interrupt list, so a later mutation does not reach it', () => {
    const state = createNodeState({interrupts: ['i1']});
    const snapshot = buildWorkflowAgentState(new Map([['gate', state]]));

    state.interrupts.push('i2');

    expect(snapshot.nodes['gate'].interrupts).toEqual(['i1']);
  });

  it('snapshots an empty graph as an empty node map', () => {
    expect(buildWorkflowAgentState(new Map())).toEqual({nodes: {}});
  });
});

describe('workflow checkpoint events', () => {
  it('carries the snapshot on actions.agentState', () => {
    const nodes = new Map([
      ['a', createNodeState({status: NodeStatus.COMPLETED})],
    ]);

    const event = createNodeCheckpointEvent(origin, nodes);

    expect(event.author).toBe('wf');
    expect(event.invocationId).toBe('inv-1');
    expect(event.branch).toBe('b1');
    expect(event.actions.agentState).toEqual({
      nodes: {a: {status: NodeStatus.COMPLETED, interrupts: []}},
    });
  });

  it('marks the end of the agent', () => {
    const event = createEndOfAgentEvent(origin);

    expect(event.actions.endOfAgent).toBe(true);
    expect(event.author).toBe('wf');
  });

  it('re-surfaces a replayed output under the node that produced it', () => {
    const event = createReplayedOutputEvent(origin, 'wf.a', 'A(x)');

    expect(event.output).toBe('A(x)');
    expect(event.nodeInfo).toEqual({path: 'wf.a', replayed: true});
    expect(event.actions.agentState).toBeUndefined();
  });

  it('marks the replayed output so rehydration does not read it as a run', () => {
    const event = createReplayedOutputEvent(origin, 'wf.a', 'A(x)');

    expect(event.nodeInfo?.replayed).toBe(true);
  });
});
