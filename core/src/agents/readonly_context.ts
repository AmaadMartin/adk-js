/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {AuthCredential} from '../auth/auth_credential.js';
import {State} from '../sessions/state.js';

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
   * The state of the current session.
   */
  get state(): Readonly<State> {
    return new State(
      this.invocationContext.session.state,
      {},
    ) as Readonly<State>;
  }

  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  get a2aMetadata(): Record<string, unknown> | undefined {
    return this.invocationContext.a2aMetadata;
  }

  /**
   * The credential resolved for `key` during this invocation, or `undefined`
   * when none was.
   *
   * @param key The credential key of the auth config that produced it.
   * @returns The credential, or `undefined`.
   */
  getCredential(key: string): AuthCredential | undefined {
    const credentials = this.invocationContext.credentialByKey;

    // `key` is attacker-influenced, and a caller may supply the map as a `{}`
    // literal, so an inherited key such as `toString` would otherwise resolve
    // to a function rather than to `undefined`.
    return Object.hasOwn(credentials, key) ? credentials[key] : undefined;
  }
}
