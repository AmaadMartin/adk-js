/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import type {AuthCredential} from '../auth/auth_credential.js';
import {State} from '../sessions/state.js';

import {InvocationContext} from './invocation_context.js';

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
    return this.invocationContext.agent.name;
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
   * Returns the credential ADK resolved for this invocation under `key`.
   *
   * See `BaseToolset.getAuthConfig` for the toolset-level auth flow that
   * populates it.
   *
   * @param key The `credentialKey` of the auth config that asked for the
   *     credential.
   * @return The resolved credential, or `undefined` when ADK resolved none.
   */
  getCredential(key: string): AuthCredential | undefined {
    return this.invocationContext.credentialByKey[key];
  }
}
