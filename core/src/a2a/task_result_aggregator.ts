/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  TaskState as A2ATaskState,
  Message,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type {A2AEvent} from './a2a_event.js';
import {isTaskStatusUpdateEvent, TaskState} from './a2a_event.js';

/**
 * Folds the task status updates emitted during one agent run into a single
 * final task state.
 *
 * Precedence, highest first: `failed`, `auth-required`, `input-required`,
 * `working`; a lower-priority update never overwrites a higher-priority one
 * that has already been recorded.
 *
 * One instance per run: the aggregator carries per-request state.
 */
export class TaskResultAggregator {
  private state: A2ATaskState = TaskState.WORKING;
  private message?: Message;

  /** The aggregated final task state. */
  get taskState(): A2ATaskState {
    return this.state;
  }

  /** The status message recorded alongside {@link taskState}. */
  get taskStatusMessage(): Message | undefined {
    return this.message;
  }

  /**
   * Records the task-state signal carried by `event`, then rewrites the event
   * in place so it is forwarded as `working`.
   *
   * The aggregated state is tracked here instead, because a terminal state
   * reaching the A2A request handler mid-stream ends event aggregation before
   * the run is over. `event.final` and every other field are left untouched.
   */
  processEvent(event: A2AEvent): void {
    if (!isTaskStatusUpdateEvent(event)) {
      return;
    }

    const {state, message} = event.status;

    if (state === TaskState.FAILED) {
      this.state = TaskState.FAILED;
      this.message = message;
    } else if (
      state === TaskState.AUTH_REQUIRED &&
      this.state !== TaskState.FAILED
    ) {
      this.state = TaskState.AUTH_REQUIRED;
      this.message = message;
    } else if (
      state === TaskState.INPUT_REQUIRED &&
      this.state !== TaskState.FAILED &&
      this.state !== TaskState.AUTH_REQUIRED
    ) {
      this.state = TaskState.INPUT_REQUIRED;
      this.message = message;
    } else if (this.state === TaskState.WORKING) {
      this.message = message;
    }

    event.status.state = TaskState.WORKING;
  }

  /**
   * Returns the final status event to publish for the run.
   *
   * `fallback` is the status derived from the ADK event stream. It is returned
   * unchanged unless a signal of higher priority than `working` was observed,
   * in which case the aggregated state and status message win — the same
   * resolution `a2a_agent_executor.py` performs when it closes out a task.
   */
  resolveFinalStatus(fallback: TaskStatusUpdateEvent): TaskStatusUpdateEvent {
    if (this.state === TaskState.WORKING) {
      return fallback;
    }

    return {
      ...fallback,
      status: {
        state: this.state,
        message: this.message,
        timestamp: fallback.status.timestamp,
      },
    };
  }
}
