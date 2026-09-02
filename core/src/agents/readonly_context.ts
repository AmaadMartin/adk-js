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
   * A credential ADK resolved for this invocation.
   *
   * A toolset reads the credential its `getAuthConfig()` asked for here, from
   * inside `getTools()`, under that config's `credentialKey`.
   *
   * @param key The credential key to look up.
   * @returns The resolved credential, or undefined when none was stored.
   */
  getCredential(key: string): AuthCredential | undefined {
    return this.invocationContext.credentialByKey[key];
  }
}
