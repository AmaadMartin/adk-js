/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A `WorkflowNode` subclass that fans itself out: `parallelWorker: true` runs
 * `runNodeImpl` once per item of the list its predecessor produced, and the
 * node emits the ordered results. The subclass keeps its own field (`style`) on
 * every item, because the fan-out wraps a copy of the node itself.
 *
 * The sibling `parallel_worker` sample shows the same flag on the `node()`
 * factory, with a model in the loop. This one is a subclass and runs offline.
 *
 * Run (offline):  npm run sample -- tests/integration/workflows/workflow_node_parallel/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowNode} from '@google/adk';

const splitTopics = node(
  (_ctx: NodeContext, text: string) =>
    text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  {name: 'split_topics'},
);

class Summarize extends WorkflowNode<string, string> {
  constructor(private readonly style: string) {
    super({name: 'summarize', parallelWorker: true, maxParallelWorkers: 3});
  }

  protected async *runNodeImpl(_ctx: NodeContext, topic: string) {
    yield `${this.style}: ${topic}`;
  }
}

const joinLines = node(
  (_ctx: NodeContext, summaries: string[]) => summaries.join('\n'),
  {name: 'join_lines'},
);

export const rootAgent = new Workflow({
  name: 'workflow_node_parallel',
  edges: [['START', splitTopics, new Summarize('terse'), joinLines]],
});
