/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {ArtifactVersion} from '../artifacts/base_artifact_service.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthHandler} from '../auth/auth_handler.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {createEventActions, EventActions} from '../events/event_actions.js';
import {SearchMemoryResponse} from '../memory/base_memory_service.js';
import {State} from '../sessions/state.js';
import {ResumeInputs} from '../tools/resume_inputs.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';

import {InvocationContext} from './invocation_context.js';
import {ReadonlyContext} from './readonly_context.js';

/**
 * The context of various callbacks within an agent run.
 *
 * This class provides the context for callbacks and tool invocations, including
 * access to the invocation context, function call ID, event actions, and
 * authentication response. It also provides methods for requesting credentials,
 * retrieving authentication responses, loading and saving artifacts, and
 * searching memory.
 *
 * Reference: `google/adk-python` `src/google/adk/agents/context.py::Context`.
 * That one Python class covers two roles, and adk-js splits them. This class is
 * the callback and tool half. The workflow half — node path, run id, child
 * execution, output and routing — is `NodeContext` in
 * `core/src/workflow/node_context.ts`. A member missing here is likely to live
 * there.
 */
export class Context extends ReadonlyContext {
  private readonly _state: State;

  readonly eventActions: EventActions;
  readonly functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
  readonly resumeInputs: ResumeInputs;
  readonly abortSignal?: AbortSignal;

  /**
   * @param options The configuration options for the Context.
   * @param options.invocationContext The invocation context.
   * @param options.eventActions The event actions of the current call.
   * @param options.functionCallId The function call id of the current tool call.
   *     This id was returned in the function call event from LLM to identify a
   *     function call. If LLM didn't return this id, ADK will assign one to it.
   *     This id is used to map function call response to the original function
   *     call.
   * @param options.toolConfirmation The tool confirmation of the current tool
   *     call.
   * @param options.resumeInputs The inputs the current tool call is being
   *     resumed with, if it paused to ask for them, keyed by interrupt id.
   *     Defaults to empty rather than absent, matching adk-python's
   *     `Context.resume_inputs`. Carries no approval; see
   *     {@link ResumeInputs}.
   */
  constructor(options: {
    invocationContext: InvocationContext;
    eventActions?: EventActions;
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
    resumeInputs?: ResumeInputs;
  }) {
    super(options.invocationContext);
    this.eventActions = options.eventActions || createEventActions();
    this._state = new State(
      options.invocationContext.session.state,
      this.eventActions.stateDelta,
    );
    this.functionCallId = options.functionCallId;
    this.toolConfirmation = options.toolConfirmation;
    this.resumeInputs = options.resumeInputs ?? {};
    this.abortSignal = options.invocationContext.abortSignal;
  }

  /**
   * The branch of the current invocation, if it runs on one.
   */
  get branch(): string | undefined {
    return this.invocationContext.branch;
  }

  /**
   * The delta-aware state of the current session.
   */
  override get state() {
    return this._state;
  }

  get actions(): EventActions {
    return this.eventActions;
  }

  /**
   * Loads an artifact attached to the current session.
   *
   * @param filename The filename of the artifact.
   * @param version The version of the artifact. If not provided, the latest
   *     version will be used.
   * @return A promise that resolves to the loaded artifact.
   */
  loadArtifact(filename: string, version?: number): Promise<Part | undefined> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.invocationContext.artifactService.loadArtifact({
      filename,
      version,
    });
  }

  /**
   * Saves an artifact attached to the current session.
   *
   * @param filename The filename of the artifact.
   * @param artifact The artifact to save.
   * @param customMetadata Free-form metadata stored alongside the version.
   * @return A promise that resolves to the version of the saved artifact.
   */
  async saveArtifact(
    filename: string,
    artifact: Part,
    customMetadata?: Record<string, unknown>,
  ): Promise<number> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    const version = await this.invocationContext.artifactService.saveArtifact({
      filename,
      artifact,
      customMetadata,
    });
    this.eventActions.artifactDelta[filename] = version;

    return version;
  }

  /**
   * Gets the version metadata of an artifact attached to the current session.
   *
   * @param filename The filename of the artifact.
   * @param version The version of the artifact. If not provided, the latest
   *     version will be used.
   * @return A promise that resolves to the artifact version, or undefined when
   *     the artifact has no such version.
   */
  getArtifactVersion(
    filename: string,
    version?: number,
  ): Promise<ArtifactVersion | undefined> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.invocationContext.artifactService.getArtifactVersion({
      filename,
      version,
    });
  }

  requestCredential(authConfig: AuthConfig) {
    if (!this.functionCallId) {
      throw new Error('functionCallId is not set.');
    }

    const authHandler = new AuthHandler(authConfig);
    this.eventActions.requestedAuthConfigs[this.functionCallId] =
      authHandler.generateAuthRequest();
  }

  /**
   * Gets the auth credential for the given auth config.
   *
   * @param authConfig The auth config to get the auth credential for.
   * @return The auth credential for the given auth config.
   */
  getAuthResponse(authConfig: AuthConfig): AuthCredential | undefined {
    const authHandler = new AuthHandler(authConfig);

    return authHandler.getAuthResponse(this.state);
  }

  /**
   * Lists the filenames of the artifacts attached to the current session.
   *
   * @return A promise that resolves to a list of artifact filenames.
   */
  listArtifacts(): Promise<string[]> {
    if (!this.invocationContext.artifactService) {
      throw new Error('Artifact service is not initialized.');
    }

    return this.invocationContext.artifactService.listArtifactKeys();
  }

  /**
   * Searches the memory of the current user.
   *
   * @param query The query to search memory for.
   * @return A promise that resolves to SearchMemoryResponse containing the
   *     matching memories.
   */
  searchMemory(query: string): Promise<SearchMemoryResponse> {
    if (!this.invocationContext.memoryService) {
      throw new Error('Memory service is not initialized.');
    }

    return this.invocationContext.memoryService.searchMemory({
      appName: this.invocationContext.session.appName,
      userId: this.invocationContext.session.userId,
      query,
    });
  }

  /**
   * Requests confirmation for the current tool call.
   */
  requestConfirmation({hint, payload}: {hint?: string; payload?: unknown}) {
    if (!this.functionCallId) {
      throw new Error('functionCallId is not set.');
    }
    this.eventActions.requestedToolConfirmations[this.functionCallId] =
      new ToolConfirmation({
        hint: hint,
        confirmed: false,
        payload: payload,
      });
  }

  /**
   * Saves the exchanged credential carried by the auth config to the
   * configured credential service.
   *
   * @param authConfig The auth config holding the credential to save.
   * @return A promise that resolves once the credential is stored.
   */
  saveCredential(authConfig: AuthConfig): Promise<void> {
    if (!this.invocationContext.credentialService) {
      throw new Error('Credential service is not initialized.');
    }

    return this.invocationContext.credentialService.saveCredential(
      authConfig,
      this,
    );
  }

  /**
   * Loads a previously saved credential for the given auth config.
   *
   * @param authConfig The auth config to load the credential for.
   * @return A promise that resolves to the stored credential, or undefined
   *     when the store holds none.
   */
  loadCredential(authConfig: AuthConfig): Promise<AuthCredential | undefined> {
    if (!this.invocationContext.credentialService) {
      throw new Error('Credential service is not initialized.');
    }

    return this.invocationContext.credentialService.loadCredential(
      authConfig,
      this,
    );
  }

  /**
   * Adds the current session to memory, so a later invocation can recall it.
   *
   * @return A promise that resolves once the session is ingested.
   */
  addSessionToMemory(): Promise<void> {
    if (!this.invocationContext.memoryService) {
      throw new Error(
        'Cannot add session to memory: memory service is not available.',
      );
    }

    return this.invocationContext.memoryService.addSessionToMemory(
      this.invocationContext.session,
    );
  }
}
