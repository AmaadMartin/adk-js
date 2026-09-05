/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {AuthCredential} from '../auth/auth_credential.js';
import {ReadonlyState, ReadonlyStateView} from '../sessions/readonly_state.js';
import type {Session} from '../sessions/session.js';

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
   * The branch of the current invocation, if it runs on one.
   *
   * A dot-separated agent path (`agent_1.agent_2.agent_3`) that scopes which
   * events an agent sees.
   */
  get branch(): string | undefined {
    return this.invocationContext.branch;
  }

  /**
   * The name of the agent that is currently running, or `'unknown'` when the
   * invocation drives a bare node and has no agent at this level.
   */
  get agentName(): string {
    return this.invocationContext.agent?.name ?? 'unknown';
  }

  /**
   * A read-only view of the state of the current session.
   *
   * Reads are live: a value a writer commits to the session after this view
   * was taken is visible through it. A write through the view throws
   * {@link ReadonlyStateError}.
   *
   * The view carries the invocation's state schema, like the writable
   * {@link Context} does, so a holder that inspects the schema sees the same
   * one the run enforces.
   */
  get state(): ReadonlyStateView {
    return new ReadonlyState(
      this.invocationContext.session.state,
      this.invocationContext.stateSchema,
    );
  }

  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  get a2aMetadata(): Record<string, unknown> | undefined {
    return this.invocationContext.a2aMetadata;
  }

  /**
   * A read-only view of the metadata that tools and services accumulated
   * during this invocation.
   */
  get customMetadata(): Readonly<Record<string, unknown>> {
    return this.invocationContext.customMetadata;
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
