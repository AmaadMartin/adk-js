/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {AuthCredential} from '../auth/auth_credential.js';
import type {Session} from '../sessions/session.js';
import {State} from '../sessions/state.js';

import {InvocationContext} from './invocation_context.js';
import type {RunConfig} from './run_config.js';

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
   * The name of the agent that is currently running, or `'unknown'` when the
   * invocation drives a bare node and has no agent at this level.
   */
  get agentName(): string {
    return this.invocationContext.agent?.name ?? 'unknown';
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
   * The current session of this invocation.
   */
  get session(): Session {
    return this.invocationContext.session;
  }

  /**
   * The run config of this invocation, or `undefined` when it has none.
   */
  get runConfig(): RunConfig | undefined {
    return this.invocationContext.runConfig;
  }

  /**
   * The credential resolved for `key` during this invocation, or `undefined`
   * when none was.
   */
  getCredential(key: string): AuthCredential | undefined {
    const credentials = this.invocationContext.credentialByKey;

    // A caller may supply the map as a `{}` literal, so guard inherited keys.
    return Object.hasOwn(credentials, key) ? credentials[key] : undefined;
  }
}
