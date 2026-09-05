/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {BaseNode, isContent} from '../base_node.js';
import {NodeContext} from '../node_context.js';

/**
 * Whether a value is an aggregated trigger record: a plain object keyed by
 * predecessor name.
 *
 * The genai `Content` exclusion has no counterpart in `google/adk-python`,
 * where `isinstance(data, dict)` already rejects a `types.Content`. In
 * TypeScript a `Content` is a plain object, so without the exclusion a
 * `Content` input would be split into `role` and `parts` and each field
 * validated against the schema.
 */
function isTriggerRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isContent(value)
  );
}

/**
 * A fan-in barrier node: via {@link requiresAllPredecessors} the engine holds it
 * until ALL of its predecessors complete, then runs it with their aggregated
 * outputs as input.
 *
 * This node emits that input unchanged — the engine supplies the
 * predecessor-name → output map; the join just passes it through as its output.
 * The barrier itself is enforced by the orchestrator (which reads
 * `requiresAllPredecessors`) and lands in a later part.
 *
 * Ported from `google/adk-python` `workflow/_join_node.py`.
 */
export class JoinNode extends BaseNode {
  override get requiresAllPredecessors(): boolean {
    return true;
  }

  /**
   * Validates each aggregated trigger value on its own.
   *
   * `inputSchema` on a join describes ONE predecessor's output, not the
   * aggregated record: that record is keyed by node name, which no user schema
   * declares, so matching the whole record against it would fail every
   * well-formed fan-in. A predecessor that produced nothing contributes
   * `null`/`undefined` and is skipped, the way `validate_node_data` short-
   * circuits on `None` in `google/adk-python`.
   *
   * Mirrors `JoinNode._validate_input_data` in `google/adk-python`
   * `workflow/_join_node.py`.
   */
  protected override validateInput(input: unknown): unknown {
    if (this.inputSchema === undefined || !isTriggerRecord(input)) {
      return super.validateInput(input);
    }
    return Object.fromEntries(
      Object.entries(input).map(([predecessor, value]) => [
        predecessor,
        value === null || value === undefined
          ? value
          : super.validateInput(value),
      ]),
    );
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      output: input,
    });
  }
}
