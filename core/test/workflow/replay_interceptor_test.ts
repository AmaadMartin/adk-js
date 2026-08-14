/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import type {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import type {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import type {RehydratedNode} from '../../src/workflow/utils/rehydration_utils.js';
import {
  checkInterception,
  interceptedResult,
} from '../../src/workflow/utils/replay_interceptor.js';
import {PlainReplyAgent} from './test_helpers.js';

/** A recovered run, defaulting to "nothing recorded". */
function recovered(partial: Partial<RehydratedNode> = {}): RehydratedNode {
  return {
    interruptIds: new Set<string>(),
    resolvedResponses: new Map<string, unknown>(),
    ...partial,
  };
}

function nodeWith(options: {rerunOnResume: boolean}): BaseNode {
  return new FunctionNode('node', () => undefined, options);
}

/** A parent context running on `branch`, for {@link interceptedResult}. */
function parentOn(branch?: string): NodeContext {
  return new NodeContext({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u',
        lastUpdateTime: Date.now(),
      }),
      agent: new PlainReplyAgent('wf'),
      pluginManager: new PluginManager(),
      branch,
    }),
    channel: new AsyncQueue<Event>(),
    nodePath: 'wf',
    runId: '1',
  });
}

describe('checkInterception', () => {
  it('runs a node the session records nothing about', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: false}),
      resumeInputs: {},
    });

    expect(decision.shouldRun).toBe(true);
  });

  it('hands back the output and route of a run that already completed', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: false}),
      prior: recovered({output: 'past-out', route: 'route-a', branch: 'b1'}),
      resumeInputs: {},
    });

    expect(decision).toEqual({
      shouldRun: false,
      output: 'past-out',
      route: 'route-a',
      branch: 'b1',
    });
  });

  it('hands back a completed run even when the node asks to re-run', () => {
    // `rerunOnResume` governs an interrupt the node is still waiting on, not a
    // run that already produced its result.
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: true}),
      prior: recovered({output: 'past-out'}),
      resumeInputs: {},
    });

    expect(decision.shouldRun).toBe(false);
    expect(decision.output).toBe('past-out');
  });

  it('re-runs a node whose interrupts are still unanswered', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: false}),
      prior: recovered({interruptIds: new Set(['fc-1', 'fc-2'])}),
      resumeInputs: {'fc-1': 'ans'},
    });

    expect(decision.shouldRun).toBe(true);
  });

  it('re-runs a node that asks to re-run once its interrupt is answered', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: true}),
      prior: recovered({
        interruptIds: new Set(['fc-1']),
        resolvedResponses: new Map([['fc-1', 'ans']]),
      }),
      resumeInputs: {'fc-1': 'ans'},
    });

    expect(decision.shouldRun).toBe(true);
  });

  it('completes a node that does not re-run with its single answer', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: false}),
      prior: recovered({interruptIds: new Set(['fc-1']), branch: 'b1'}),
      resumeInputs: {'fc-1': 'ans'},
    });

    expect(decision).toEqual({
      shouldRun: false,
      output: 'ans',
      branch: 'b1',
    });
  });

  it('completes a node that does not re-run with all of its answers', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: false}),
      prior: recovered({interruptIds: new Set(['fc-1', 'fc-2'])}),
      resumeInputs: {'fc-1': 'one', 'fc-2': 'two'},
    });

    expect(decision.shouldRun).toBe(false);
    expect(decision.output).toEqual(['one', 'two']);
  });

  it('re-runs a node whose recorded run produced nothing at all', () => {
    const decision = checkInterception({
      node: nodeWith({rerunOnResume: false}),
      prior: recovered(),
      resumeInputs: {},
    });

    expect(decision.shouldRun).toBe(true);
  });
});

describe('interceptedResult', () => {
  it('carries the recorded output and route, blocked on nothing', () => {
    const result = interceptedResult(parentOn('parent-branch'), {
      shouldRun: false,
      output: 'cached',
      route: 'left',
      branch: 'recorded-branch',
    });

    expect(result).toEqual({
      output: 'cached',
      route: 'left',
      branch: 'recorded-branch',
      interruptIds: [],
    });
  });

  it("falls back to the parent's branch when the run recorded none", () => {
    const result = interceptedResult(parentOn('parent-branch'), {
      shouldRun: false,
      output: 'cached',
    });

    expect(result.branch).toBe('parent-branch');
  });
});
