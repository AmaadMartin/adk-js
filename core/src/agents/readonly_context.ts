/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {ReadonlyState, ReadonlyStateView} from '../sessions/readonly_state.js';

import {InvocationContext, requireAgent} from './invocation_context.js';

/**
 * A readonly context represents the data of a single invocation of an agent.
 */
export class ReadonlyContext {
  constructor(readonly invocationContext: InvocationContext) {}

  /**
   * The user content that started this invocation.
   */
  get userContent(): Content | undefined {
    return this.invocationContext.userContent;
  }

  /**
   * The current invocation id.
   */
  get invocationId(): string {
    return this.invocationContext.invocationId;
  }

  /**
   * The user ID of the current session.
   */
  get userId(): string {
    return this.invocationContext.userId;
  }

  /**
   * The ID of the current session.
   */
  get sessionId(): string {
    return this.invocationContext.session.id;
  }

  /**
   * The current agent name.
   */
  get agentName(): string {
    return requireAgent(this.invocationContext).name;
  }

  /**
   * The state of the current session, as a read-only view.
   *
   * Reads pass through to the live session state. A write throws
   * `ReadonlyStateError`: use a `Context` (tool or callback) or a workflow
   * node's `ctx.state` to write state.
   */
  get state(): ReadonlyStateView {
    return new ReadonlyState(this.invocationContext.session.state);
  }

  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  get a2aMetadata(): Record<string, unknown> | undefined {
    return this.invocationContext.a2aMetadata;
  }
}
