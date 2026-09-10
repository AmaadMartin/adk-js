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

import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
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

  it('still announces the output of the attempt after a delegated one', async () => {
    let attempts = 0;
    const flaky = new GenNode(
      'flaky',
      async function* () {
        attempts++;
        if (attempts === 1) {
          yield createEvent({
            output: 'attempt-1',
            nodeInfo: {messageAsOutput: true},
          });
          throw new Error('transient');
        }
        yield 'attempt-2';
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {child, events} = await runChildNode(flaky);

    // The delegation the failed attempt claimed must not silence the attempt
    // that succeeded: its output has to reach an event, or a resumed run
    // cannot tell the node ever produced one.
    expect(child.output).toBe('attempt-2');
    expect(child.outputDelegated).toBe(false);
    expect(events.filter((e) => e.output !== undefined).map((e) => e.output)) //
      .toEqual(['attempt-1', 'attempt-2']);
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

  it('does not re-announce a fast-forwarded child output on resume', async () => {
    const answer = new FunctionNode('answer', () => 'the_answer');
    const ask = new FunctionNode(
      'ask',
      (ctx: NodeContext) => {
        const reply = ctx.resumeInputs['confirm'];
        return reply === undefined
          ? new RequestInput({interruptId: 'confirm', message: 'confirm?'})
          : `confirmed:${reply}`;
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'ff_wf',
      dynamicEntry: async (ctx: NodeContext) => {
        // The caller takes the child's output as its own, so on resume the
        // cached value arrives without the child running.
        await ctx.runNode(answer, null, {useAsOutput: true});
        await ctx.runNode(ask);
        return undefined;
      },
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent: wf, sessionService});
    const turn = async (message: Part[]): Promise<Event[]> => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: message},
      })) {
        events.push(event);
      }
      return events;
    };

    await turn([{text: 'x'}]);
    const resumed = await turn([
      {
        functionResponse: {
          id: 'confirm',
          name: 'adk_request_input',
          response: {result: 'yes'},
        },
      },
    ]);

    // The workflow itself must not emit the cached value as a node event.
    // Announcing the run's result to its caller is the invocation wrapper's
    // job, and the event it adds carries no node provenance.
    const fromWorkflow = resumed.filter(
      (e) => e.output === 'the_answer' && e.nodeInfo !== undefined,
    );
    expect(fromWorkflow).toHaveLength(0);
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

  it('prefers a code the error carries over its class name', async () => {
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
