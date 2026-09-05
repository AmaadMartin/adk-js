/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The branch arm of `enrichEvent`, ported from `google/adk-python` `main`
 * (`src/google/adk/workflow/_node_runner.py::NodeRunner._enrich_event`).
 *
 * `test_child_event_branch_does_not_mutate_parent_ic` keeps its adk-python name
 * verbatim; its source is
 * `tests/unittests/workflow/test_node_runner_ctx.py`.
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {createIc} from './test_helpers.js';

/** A node that yields exactly the events it was given. */
class EventsNode extends BaseNode {
  constructor(
    name: string,
    private readonly events: Event[],
  ) {
    super({name});
  }

  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    for (const event of this.events) {
      yield event;
    }
  }
}

/**
 * A node that redirects the branch, then fails its first attempt. Its retry
 * emits one unbranched event, so the branch that event carries shows whether
 * the failed attempt's redirect survived.
 */
class RedirectThenFailNode extends BaseNode {
  private attempts = 0;

  constructor(private readonly redirect: string = 'attempt1') {
    super({name: 'flaky', retryConfig: {maxAttempts: 2, initialDelay: 0}});
  }

  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      yield createEvent({branch: this.redirect, content: undefined});
      throw new Error('first attempt fails');
    }
    yield createEvent({content: undefined});
  }
}

/** {@link RedirectThenFailNode}, but the failed attempt cleared the branch. */
class ClearThenFailNode extends RedirectThenFailNode {
  constructor() {
    super('');
  }
}

/** Redirects the branch, then yields a plain value, then an unbranched event. */
class RedirectThenPlainNode extends BaseNode {
  constructor() {
    super({name: 'n'});
  }

  protected async *runImpl(): AsyncGenerator<Event | string, void, void> {
    yield createEvent({branch: 'audit', content: undefined});
    yield 'plain';
    yield createEvent({content: undefined});
  }
}

/** An {@link InvocationContext} whose running branch is `branch`. */
function icWithBranch(branch: string | undefined): InvocationContext {
  return new InvocationContext({...createIc(), branch});
}

/**
 * Runs `node` under `ic` and returns the events it pushed.
 *
 * `driveNode` is not used here: it runs its node with `useAsOutput: true` and
 * offers no way to set the branch in force for the run.
 */
async function driveWithBranch(
  node: BaseNode,
  ic: InvocationContext,
  overrideBranch?: string,
): Promise<Event[]> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const settle = root.runNode(node, undefined, {overrideBranch}).then(
    () => channel.close(),
    (err: unknown) => channel.fail(err),
  );
  for await (const event of channel) {
    events.push(event);
  }
  await settle;
  return events;
}

describe('node_runner — the branch an event inherits and redirects', () => {
  it('stamps the running branch on an event that carries none', async () => {
    const node = new EventsNode('n', [createEvent({content: undefined})]);

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events).toHaveLength(1);
    expect(events[0].branch).toBe('parent_branch');
  });

  it('leaves an event unbranched when the run has no branch', async () => {
    const node = new EventsNode('n', [createEvent({content: undefined})]);

    const events = await driveWithBranch(node, icWithBranch(undefined));

    expect(events).toHaveLength(1);
    expect(events[0].branch).toBeUndefined();
  });

  it('test_child_event_branch_does_not_mutate_parent_ic', async () => {
    const ic = icWithBranch('parent_branch');
    const node = new EventsNode('n', [
      createEvent({output: 'result', branch: 'new_child_branch'}),
    ]);

    const events = await driveWithBranch(node, ic);

    expect(events[0].branch).toBe('new_child_branch');
    expect(ic.branch).toBe('parent_branch');
  });

  it("adopts an event's branch for the events that follow it", async () => {
    const node = new EventsNode('n', [
      createEvent({branch: 'new_child_branch', content: undefined}),
      createEvent({content: undefined}),
    ]);

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events.map((e) => e.branch)).toEqual([
      'new_child_branch',
      'new_child_branch',
    ]);
  });

  it('clears the branch on an event that carries an empty string', async () => {
    const node = new EventsNode('n', [
      createEvent({branch: '', content: undefined}),
    ]);

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events).toHaveLength(1);
    expect(events[0].branch).toBeUndefined();
  });

  it('clears the branch for the events that follow an empty string', async () => {
    const node = new EventsNode('n', [
      createEvent({branch: '', content: undefined}),
      createEvent({content: undefined}),
    ]);

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events.map((e) => e.branch)).toEqual([undefined, undefined]);
  });

  it('does not mutate the parent context when an event clears the branch', async () => {
    const ic = icWithBranch('parent_branch');
    const node = new EventsNode('n', [
      createEvent({branch: '', content: undefined}),
    ]);

    await driveWithBranch(node, ic);

    expect(ic.branch).toBe('parent_branch');
  });

  it('keeps a sub-branch run independent of the parent branch', async () => {
    const ic = icWithBranch('parent_branch');
    const node = new EventsNode('n', [
      createEvent({branch: '', content: undefined}),
      createEvent({content: undefined}),
    ]);

    const events = await driveWithBranch(node, ic, 'override_branch');

    expect(events.map((e) => e.branch)).toEqual([undefined, undefined]);
    expect(ic.branch).toBe('parent_branch');
  });

  it('discards a redirect made by an attempt that then failed', async () => {
    const node = new RedirectThenFailNode();

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    // The failed attempt's event, its error event, then the retry's event.
    expect(events.map((e) => e.branch)).toEqual([
      'attempt1',
      'attempt1',
      'parent_branch',
    ]);
  });

  it('discards a cleared branch when the attempt that cleared it failed', async () => {
    const node = new ClearThenFailNode();

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events.map((e) => e.branch)).toEqual([
      undefined,
      undefined,
      'parent_branch',
    ]);
  });

  it('re-stamps the node branch when the node yields a plain value', async () => {
    const node = new RedirectThenPlainNode();

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events.map((e) => e.branch)).toEqual([
      'audit',
      'parent_branch',
      'parent_branch',
    ]);
  });

  it("adopts a foreign author's branch, as adk-python does", async () => {
    const node = new EventsNode('n', [
      createEvent({author: 'sub_agent', branch: 'parent_branch.sub'}),
      createEvent({content: undefined}),
    ]);

    const events = await driveWithBranch(node, icWithBranch('parent_branch'));

    expect(events.map((e) => e.branch)).toEqual([
      'parent_branch.sub',
      'parent_branch.sub',
    ]);
  });
});
