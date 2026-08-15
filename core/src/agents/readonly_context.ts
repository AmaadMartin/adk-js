/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {State} from '../sessions/state.js';

import {InvocationContext, requireAgent} from './invocation_context.js';

/**
 * A live, read-only view of `record`: reads pass through, writes throw.
 *
 * A view rather than a snapshot, so a value a legitimate writer puts into the
 * underlying record later is visible here. The view is shallow: a nested
 * object read out of it is the live object and stays mutable.
 *
 * Every trap that can reach the record throws, so a plain-JavaScript caller
 * without the type cannot corrupt a store the whole invocation shares.
 */
function readonlyView(
  record: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const reject = (
    _target: Record<string, unknown>,
    key: string | symbol,
  ): never => {
    throw new TypeError(
      `Cannot modify '${String(key)}': ReadonlyContext.customMetadata is a ` +
        'read-only view of the invocation metadata.',
    );
  };
  return new Proxy(record, {
    set: reject,
    deleteProperty: reject,
    defineProperty: reject,
  });
}

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
   * The state of the current session.
   */
  get state(): Readonly<State> {
    return new State(
      this.invocationContext.session.state,
      {},
    ) as Readonly<State>;
  }

  /**
   * Custom metadata for this invocation, as a read-only view.
   *
   * Seeded from `RunConfig.customMetadata`, and `{}` when nothing was
   * configured. Reads pass through to the live store; a write throws
   * `TypeError`.
   */
  get customMetadata(): Readonly<Record<string, unknown>> {
    return readonlyView(this.invocationContext.customMetadata);
  }
}
