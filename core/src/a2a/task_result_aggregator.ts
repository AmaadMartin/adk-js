/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, TaskStatus} from '@a2a-js/sdk';
import {A2AEvent, isTaskStatusUpdateEvent, TaskState} from './a2a_event.js';

/**
 * The task states a run can settle on, most severe first. A state absent from
 * this list, such as `completed`, never settles the task: the executor decides
 * the terminal state once the run is over.
 */
const SETTLING_STATES: ReadonlyArray<TaskStatus['state']> = [
  TaskState.FAILED,
  TaskState.AUTH_REQUIRED,
  TaskState.INPUT_REQUIRED,
];

const UNSETTLED = SETTLING_STATES.length;

function severityOf(state: TaskStatus['state']): number {
  const index = SETTLING_STATES.indexOf(state);

  return index === -1 ? UNSETTLED : index;
}

/**
 * Aggregates the status updates a run publishes and reports the state the task
 * settled on.
 *
 * A more severe state never gives way to a less severe one: `failed` beats
 * `auth-required`, which beats `input-required`. While nothing has settled the
 * task, the latest status message wins and the state stays `working`.
 */
export class TaskResultAggregator {
  private state: TaskStatus['state'] = TaskState.WORKING;
  private statusMessage?: Message;

  /** The state the task settled on, or `working` if nothing settled it. */
  get taskState(): TaskStatus['state'] {
    return this.state;
  }

  /** The status message that came with the settling event, if any. */
  get taskStatusMessage(): Message | undefined {
    return this.statusMessage;
  }

  /**
   * Records the state an event reports, then rewrites the event to a
   * non-terminal `working` update.
   *
   * The rewrite is load-bearing: an intermediate event that keeps a terminal
   * state or `final: true` ends the client's stream before the run publishes
   * its real terminal event. Events other than status updates are ignored.
   */
  processEvent(event: A2AEvent): void {
    if (!isTaskStatusUpdateEvent(event)) {
      return;
    }

    const incoming = severityOf(event.status.state);
    if (incoming < UNSETTLED && incoming <= severityOf(this.state)) {
      this.state = event.status.state;
      this.statusMessage = event.status.message;
    } else if (this.state === TaskState.WORKING) {
      this.statusMessage = event.status.message;
    }

    event.status.state = TaskState.WORKING;
    event.final = false;
  }
}
