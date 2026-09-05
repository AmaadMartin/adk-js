/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A resumable app persists a `Workflow`'s progress on the event stream: a node
 * checkpoint per scheduled node and per completion, and an end-of-agent marker
 * once the graph finishes. A non-resumable app writes none of it.
 *
 * The checkpoint payload mirrors adk-python's `Workflow._emit_node_checkpoint`
 * (`workflow/_workflow.py` at `25f5214c`), so a session one runtime writes stays
 * readable by the other.
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeStatus} from '../../src/workflow/node_status.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {WorkflowAgentState} from '../../src/workflow/utils/checkpoint_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow} from './test_helpers.js';

/** An invocation context whose app declares itself resumable. */
function resumableIc(): InvocationContext {
  return createIc().clone({resumabilityConfig: {isResumable: true}});
}

/** The `{nodes: ...}` snapshots carried on the stream, oldest first. */
function checkpoints(events: Event[]): WorkflowAgentState[] {
  return events
    .map((e) => e.actions?.agentState)
    .filter(
      (state): state is WorkflowAgentState =>
        state !== undefined && 'nodes' in state,
    );
}

function endOfAgentCount(events: Event[]): number {
  return events.filter((e) => e.actions?.endOfAgent === true).length;
}

describe('Workflow resumability checkpoints', () => {
  const first = new FunctionNode('first', (_c, input) => `first(${input})`);
  const second = new FunctionNode('second', (_c, input) => `second(${input})`);

  it('writes no checkpoint and no end-of-agent on a plain session', async () => {
    const wf = new Workflow({name: 'plain', edges: [['START', first, second]]});

    const {events, output} = await driveWorkflow(wf, 'x');

    expect(output).toBe('second(first(x))');
    expect(checkpoints(events)).toEqual([]);
    expect(endOfAgentCount(events)).toBe(0);
  });

  it('records a checkpoint when a node is scheduled and when it completes', async () => {
    const wf = new Workflow({name: 'ckpt', edges: [['START', first, second]]});

    const {events} = await driveWorkflow(wf, 'x', {ic: resumableIc()});

    // first scheduled, first completed, second scheduled, second completed.
    expect(checkpoints(events)).toEqual([
      {nodes: {first: {status: NodeStatus.RUNNING, interrupts: []}}},
      {nodes: {first: {status: NodeStatus.COMPLETED, interrupts: []}}},
      {
        nodes: {
          first: {status: NodeStatus.COMPLETED, interrupts: []},
          second: {status: NodeStatus.RUNNING, interrupts: []},
        },
      },
      {
        nodes: {
          first: {status: NodeStatus.COMPLETED, interrupts: []},
          second: {status: NodeStatus.COMPLETED, interrupts: []},
        },
      },
    ]);
  });

  it('marks the end of the agent once the graph finishes cleanly', async () => {
    const wf = new Workflow({name: 'done', edges: [['START', first]]});

    const {events} = await driveWorkflow(wf, 'x', {ic: resumableIc()});

    expect(endOfAgentCount(events)).toBe(1);
    // The marker is last: everything the graph did precedes it.
    expect(events[events.length - 1].actions?.endOfAgent).toBe(true);
  });

  it('carries the pending interrupt ids on a waiting node checkpoint', async () => {
    const ask = new FunctionNode(
      'ask',
      () =>
        new RequestInput({
          interruptId: 'i1',
          message: 'name?',
        }),
    );
    const wf = new Workflow({name: 'hitl', edges: [['START', ask]]});

    const {events, interruptIds} = await driveWorkflow(wf, 'x', {
      ic: resumableIc(),
    });

    expect(interruptIds).toEqual(['i1']);
    expect(checkpoints(events).at(-1)).toEqual({
      nodes: {ask: {status: NodeStatus.WAITING, interrupts: ['i1']}},
    });
  });

  it('withholds the end-of-agent marker while an interrupt is pending', async () => {
    const ask = new FunctionNode(
      'ask',
      () => new RequestInput({interruptId: 'i1'}),
    );
    const wf = new Workflow({name: 'paused', edges: [['START', ask]]});

    const {events} = await driveWorkflow(wf, 'x', {ic: resumableIc()});

    expect(endOfAgentCount(events)).toBe(0);
  });

  it('keeps the resume credential out of the checkpoint', async () => {
    const ask = new FunctionNode(
      'ask',
      () => new RequestInput({interruptId: 'secret-gate'}),
    );
    const wf = new Workflow({name: 'auth', edges: [['START', ask]]});

    const {events} = await driveWorkflow(wf, 'x', {
      ic: resumableIc(),
      resumeInputs: {'secret-gate': {accessToken: 'do-not-persist'}},
    });

    // `resumeInputs` is deliberately absent from the payload: for a node behind
    // an auth gate those hold the user's credential.
    expect(JSON.stringify(checkpoints(events))).not.toContain('do-not-persist');
    for (const checkpoint of checkpoints(events)) {
      for (const node of Object.values(checkpoint.nodes)) {
        expect(Object.keys(node).sort()).toEqual(['interrupts', 'status']);
      }
    }
  });

  it('re-emits a fast-forwarded output instead of a fresh checkpoint', async () => {
    let aRuns = 0;
    const a = new FunctionNode('a', (_c, input) => {
      aRuns++;
      return `A(${input})`;
    });
    const gate = new FunctionNode(
      'gate',
      (ctx) =>
        ctx.resumeInputs['gate-1'] ??
        new RequestInput({interruptId: 'gate-1', message: 'approve?'}),
      {rerunOnResume: true},
    );
    const wf = new Workflow({name: 'ff', edges: [['START', a, gate]]});

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'app',
      userId: 'u1',
    });
    const runner = new Runner({
      appName: 'app',
      agent: wf,
      sessionService,
      resumabilityConfig: {isResumable: true},
    });
    const drain = async (newMessage: Content): Promise<Event[]> => {
      const out: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage,
      })) {
        out.push(event);
      }
      return out;
    };

    await drain({role: 'user', parts: [{text: 'x'}]});
    const turn2 = await drain({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'gate-1',
            name: 'adk_request_input',
            response: {result: 'approved'},
          },
        },
      ],
    });

    expect(aRuns).toBe(1);
    // The replayed node re-surfaces its recovered output under its own path,
    // so the resumable stream still records what it produced.
    const replayed = turn2.filter(
      (e) => e.author === 'ff' && e.nodeInfo?.path === 'ff.a',
    );
    expect(replayed.map((e) => e.output)).toEqual(['A(x)']);
    expect(replayed.every((e) => e.actions?.agentState === undefined)).toBe(
      true,
    );
    // `a` is only ever RUNNING or COMPLETED in a checkpoint written for the
    // node that genuinely ran, never announced afresh by the replay.
    expect(
      checkpoints(turn2).filter(
        (c) => c.nodes['a']?.status === NodeStatus.RUNNING,
      ),
    ).toEqual([]);
  });

  it('delegates the output only when a terminal node produced one', async () => {
    const quiet = new FunctionNode('quiet', () => undefined);
    const withOutput = new Workflow({
      name: 'has_output',
      edges: [['START', first]],
    });
    const withoutOutput = new Workflow({
      name: 'no_output',
      edges: [['START', quiet]],
    });

    // A terminal node's own output event names the workflow in
    // `nodeInfo.outputFor`, so the workflow must not repeat it.
    const delegated = await driveWorkflow(withOutput, 'x');
    expect(delegated.output).toBe('first(x)');
    expect(
      delegated.events.filter((e) =>
        e.nodeInfo?.outputFor?.includes('has_output'),
      ),
    ).toHaveLength(1);

    const plain = await driveWorkflow(withoutOutput, 'x');
    expect(plain.output).toBeUndefined();
  });
});
