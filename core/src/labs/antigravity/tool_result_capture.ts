/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Buffers the outcome of tool calls, keyed by the call they answer.
 *
 * A client-side tool's outcome never reaches the trajectory: the terminal step
 * for such a call carries an empty `toolCalls`, and a step has no field for a
 * result in the first place. The tool hooks are the one place it does arrive,
 * so it is captured there and held until the event converter can pair it with
 * its call.
 *
 * Success and failure arrive on different hooks, and exactly one of them fires
 * per call: the harness routes a failed tool to `on_tool_error` and never to
 * `post_tool_call`. Hence the two hooks below, both feeding one buffer.
 */

import {logger} from '../../utils/logger.js';
import {
  AntigravityToolResult,
  isAntigravityToolExecutionError,
  OnToolErrorHook,
  PostToolCallHook,
} from './sdk_types.js';

/**
 * One Antigravity conversation's tool outcomes, keyed by the call id.
 *
 * A class rather than loose functions because the entries have a lifecycle: the
 * hooks fill the buffer during a turn, the converter drains it, and the turn
 * clears whatever is left. Nothing survives the turn.
 */
export class ToolResultBuffer {
  private readonly results = new Map<string, AntigravityToolResult>();

  /**
   * How many outcomes are buffered.
   *
   * The port of Python's `ToolResultBuffer.__len__` and, like it, read by the
   * tests rather than by a turn. It does not duplicate {@link take}: `take`
   * answers by call id, so it cannot observe an outcome that was dropped for
   * having no id, which is the one thing {@link record} and
   * {@link recordError} promise to do.
   */
  get size(): number {
    return this.results.size;
  }

  /** Buffers one tool result, dropping one that cannot be correlated. */
  record(result: AntigravityToolResult): void {
    // The id is the only thing tying a result to an emitted function call, so
    // keeping one without it risks draining it against an unrelated call.
    if (!result.id) {
      logger.debug(
        `[ADK] Dropping an Antigravity tool result for ${result.name}: it ` +
          `carries no call id to correlate it with.`,
      );
      return;
    }
    this.results.set(result.id, result);
  }

  /** Buffers one failed tool call, dropping one that cannot be correlated. */
  recordError(error: unknown): void {
    if (!isAntigravityToolExecutionError(error)) {
      logger.debug(
        '[ADK] Dropping an Antigravity tool failure: it carries no tool name ' +
          'to correlate it with.',
      );
      return;
    }
    if (!error.callId) {
      logger.debug(
        `[ADK] Dropping an Antigravity tool failure for ${error.toolName}: it ` +
          `carries no call id to correlate it with.`,
      );
      return;
    }
    this.results.set(error.callId, {
      name: error.toolName,
      id: error.callId,
      result: null,
      error: error.message || 'Tool call execution failed.',
    });
  }

  /**
   * Removes and returns any buffered outcomes for `callIds`.
   *
   * Insertion order is arrival order, so the outcomes come back in the order
   * the tools finished in.
   */
  take(callIds: ReadonlySet<string>): Array<[string, AntigravityToolResult]> {
    const taken: Array<[string, AntigravityToolResult]> = [];
    for (const [callId, result] of this.results) {
      if (callIds.has(callId)) {
        taken.push([callId, result]);
      }
    }
    for (const [callId] of taken) {
      this.results.delete(callId);
    }
    return taken;
  }

  /** Forgets everything buffered. */
  clear(): void {
    this.results.clear();
  }
}

/** Builds the hook that reports a successful tool call into `buffer`. */
export function createToolResultCapture(
  buffer: ToolResultBuffer,
): PostToolCallHook {
  return {
    kind: 'post_tool_call',
    async run(result: AntigravityToolResult): Promise<void> {
      buffer.record(result);
    },
  };
}

/**
 * Builds the hook that reports a failed tool call into `buffer`.
 *
 * A second object rather than a second method on the first, because a JS
 * adapter still has to tell the two hooks apart to register them on the right
 * lifecycle. It answers `undefined`, which is what leaves the harness's own
 * error message in place: this hook is an observer.
 */
export function createToolErrorCapture(
  buffer: ToolResultBuffer,
): OnToolErrorHook {
  return {
    kind: 'on_tool_error',
    async run(error: unknown): Promise<string | undefined> {
      buffer.recordError(error);
      return undefined;
    },
  };
}
