/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The end-of-node flush and the event tracking around it, for the cases the
 * ported adk-python suites do not reach: `messageAsOutput`, the native-author
 * guard, `transferToAgent`, the flush staying silent on the ordinary path, and
 * resume state surviving a retry.
 */

import {describe, expect, it} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {
  driveWorkflow,
  FnNode,
  GenNode,
  runChildNode,
  runFailingChildNode,
} from './test_helpers.js';

describe('node runner — messageAsOutput', () => {
  it('promotes the content of an event that carries no output', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({
        content: {role: 'model', parts: [{text: 'the answer'}]},
        nodeInfo: {messageAsOutput: true},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.output).toEqual({
      role: 'model',
      parts: [{text: 'the answer'}],
    });
  });

  it('leaves an explicit output alone', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({
        output: 'explicit',
        content: {role: 'model', parts: [{text: 'prose'}]},
        nodeInfo: {messageAsOutput: true},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.output).toBe('explicit');
  });

  it('delegates the output, so the flush adds no second event', async () => {
    const n = new GenNode('n', async function* (ctx: NodeContext) {
      yield createEvent({
        output: 'answered',
        nodeInfo: {messageAsOutput: true},
      });
      // Assigned after the event: without the delegation flag this would be
      // flushed as a second output event carrying the same value.
      ctx.output = 'answered';
    });

    const {child, events} = await runChildNode(n);

    expect(child.outputDelegated).toBe(true);
    expect(events.filter((e) => e.output !== undefined)).toHaveLength(1);
  });
});

describe('node runner — decisions from native events only', () => {
  it('takes the route and transfer of an event the node authored', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({
        author: 'n',
        route: 'left',
        actions: {transferToAgent: 'agent_b'},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.route).toBe('left');
    expect(child.actions.transferToAgent).toBe('agent_b');
  });

  it('takes them from an event with no author of its own', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({
        route: 'right',
        actions: {transferToAgent: 'agent_c'},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.route).toBe('right');
    expect(child.actions.transferToAgent).toBe('agent_c');
  });

  it('ignores them on an event a nested agent authored', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({
        author: 'nested_agent',
        route: 'left',
        actions: {transferToAgent: 'agent_b'},
      });
    });

    const {child} = await runChildNode(n);

    expect(child.route).toBeUndefined();
    expect(child.actions.transferToAgent).toBeUndefined();
  });
});

describe('node runner — the flush stays silent when nothing is pending', () => {
  it('adds no event for a node that emitted its output normally', async () => {
    const n = new GenNode('n', async function* () {
      yield 'done';
    });

    const {events} = await runChildNode(n);

    expect(events).toHaveLength(1);
    expect(events[0].output).toBe('done');
  });

  it('adds no event for a node that produced nothing at all', async () => {
    const {events} = await runChildNode(new FnNode('n', () => undefined));

    expect(events).toHaveLength(0);
  });

  it('does not repeat a workflow terminal node output', async () => {
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'result', {name: 'only'})]],
    });

    const {events, output} = await driveWorkflow(wf, 'x');

    expect(output).toBe('result');
    expect(events.filter((e) => e.output !== undefined)).toHaveLength(1);
  });

  it('does not repeat the output a ctx.runNode child produced for its caller', async () => {
    const wf = new Workflow({
      name: 'wf',
      dynamicEntry: async (ctx: NodeContext) => {
        await ctx.runNode(
          node(() => 'from_child', {name: 'inner'}),
          null,
          {
            useAsOutput: true,
          },
        );
        return undefined;
      },
    });

    const {events, output} = await driveWorkflow(wf, 'x');

    expect(output).toBe('from_child');
    const withOutput = events.filter((e) => e.output !== undefined);
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].author).toBe('inner');
  });

  it('does not repeat a delta a FunctionNode already emitted', async () => {
    const writer = node(
      (ctx: NodeContext) => {
        ctx.state.set('written', 'once');
        return 'ok';
      },
      {name: 'writer'},
    );

    const {events, child} = await runChildNode(writer);

    const deltas = events
      .map((e) => e.actions.stateDelta)
      .filter((delta) => Object.keys(delta).length > 0);
    expect(deltas).toEqual([{written: 'once'}]);
    expect(child.actions.stateDelta).toEqual({});
  });
});

describe('node runner — resume state across a retry', () => {
  it('re-seeds the prior output and interrupt ids on the second attempt', async () => {
    let attempts = 0;
    const seen: Array<{output: unknown; ids: string[]}> = [];
    const flaky = new FnNode(
      'flaky',
      (ctx) => {
        attempts++;
        seen.push({output: ctx.output, ids: [...ctx.interruptIds]});
        if (attempts === 1) {
          throw new Error('transient');
        }
        return undefined;
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {child} = await runChildNode(flaky, {
      priorOutput: 'carried',
      priorInterruptIds: ['fc-old'],
    });

    expect(seen).toEqual([
      {output: 'carried', ids: ['fc-old']},
      {output: 'carried', ids: ['fc-old']},
    ]);
    expect(child.output).toBe('carried');
    expect(child.interruptIds).toEqual(['fc-old']);
  });

  it('does not duplicate an interrupt id the node raises again', async () => {
    const n = new GenNode('n', async function* () {
      yield createEvent({longRunningToolIds: ['fc-old']});
    });

    const {child} = await runChildNode(n, {priorInterruptIds: ['fc-old']});

    expect(child.interruptIds).toEqual(['fc-old']);
  });
});

describe('node runner — the error code of a failed attempt', () => {
  it('falls back to UNKNOWN_ERROR for a thrown value that is not an Error', async () => {
    const n = new FnNode('n', () => {
      throw 'just a string';
    });

    const {events} = await runFailingChildNode(n);

    const failed = events.filter((e) => e.errorCode !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0].errorCode).toBe('UNKNOWN_ERROR');
    expect(failed[0].errorMessage).toBe('just a string');
  });

  it('keeps a code the error carries when it has no status', async () => {
    const coded = Object.assign(new TypeError('connection refused'), {
      code: 'ECONNREFUSED',
    });
    const n = new FnNode('n', () => {
      throw coded;
    });

    const {events} = await runFailingChildNode(n);

    expect(events[0].errorCode).toBe('ECONNREFUSED');
  });
});

describe('node runner — the artifact delta of a failed attempt', () => {
  it('does not carry a failed attempt artifact save into the retry', async () => {
    let attempts = 0;
    const flaky = new FnNode(
      'flaky',
      (ctx) => {
        attempts++;
        ctx.actions.artifactDelta[`attempt-${attempts}.txt`] = attempts;
        if (attempts === 1) {
          throw new Error('transient');
        }
        return 'ok';
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {events} = await runChildNode(flaky);

    const deltas = Object.assign(
      {},
      ...events.map((e) => e.actions.artifactDelta),
    );
    expect(deltas).toEqual({'attempt-2.txt': 2});
  });
});
