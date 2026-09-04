/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports of `google/adk-python` `tests/unittests/agents/test_context.py`
 * (reference: `src/google/adk/agents/context.py`).
 *
 * Each `it(...)` string keeps the Python test name verbatim so the two suites
 * can be compared by name. Tests covering the workflow half of Python's
 * `Context` live in `core/test/workflow/node_context_parity_test.ts`, because
 * adk-js splits that half into `NodeContext`.
 */

import {
  ArtifactVersion,
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  BaseCredentialService,
  BaseMemoryService,
  Context,
  InvocationContext,
  MemoryEntry,
  PluginManager,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
  SessionArtifactService,
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
  ToolConfirmation,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeSession(): Session {
  return {
    id: 'test-session-id',
    appName: 'test-app',
    userId: 'test-user',
    state: {key1: 'value1', key2: 'value2'},
    events: [],
    lastUpdateTime: Date.now(),
  };
}

function makeInvocationContext(
  overrides: Partial<{
    artifactService: SessionArtifactService;
    memoryService: BaseMemoryService;
    credentialService: BaseCredentialService;
    branch: string;
  }> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    session: makeSession(),
    pluginManager: new PluginManager(),
    ...overrides,
  });
}

/** Records the artifact calls a test wants to assert on. */
class RecordingArtifactService implements SessionArtifactService {
  readonly saved: SessionSaveArtifactRequest[] = [];
  readonly loaded: SessionLoadArtifactRequest[] = [];
  readonly versionsRequested: SessionLoadArtifactRequest[] = [];
  readonly keys = ['file1.txt', 'file2.txt', 'file3.txt'];
  readonly stored: Part = {text: 'test content'};
  readonly version: ArtifactVersion = {
    version: 2,
    canonicalUri: 'memory://test_file.txt#2',
    mimeType: 'text/plain',
  };

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    this.saved.push(request);
    return 1;
  }

  async loadArtifact(
    request: SessionLoadArtifactRequest,
  ): Promise<Part | undefined> {
    this.loaded.push(request);
    return this.stored;
  }

  async listArtifactKeys(): Promise<string[]> {
    return this.keys;
  }

  async deleteArtifact(): Promise<void> {}

  async listVersions(): Promise<number[]> {
    return [1, 2];
  }

  async listArtifactVersions(): Promise<ArtifactVersion[]> {
    return [this.version];
  }

  async getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    this.versionsRequested.push(request);
    return this.version;
  }
}

/** Records the credential calls, and hands back a fixed credential. */
class RecordingCredentialService implements BaseCredentialService {
  readonly saved: Array<{authConfig: AuthConfig; context: Context}> = [];
  readonly loadedFor: Array<{authConfig: AuthConfig; context: Context}> = [];
  readonly credential: AuthCredential = {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'test-api-key',
  };

  async saveCredential(
    authConfig: AuthConfig,
    context: Context,
  ): Promise<void> {
    this.saved.push({authConfig, context});
  }

  async loadCredential(
    authConfig: AuthConfig,
    context: Context,
  ): Promise<AuthCredential | undefined> {
    this.loadedFor.push({authConfig, context});
    return this.credential;
  }
}

/** Records the memory calls a test wants to assert on. */
class RecordingMemoryService implements BaseMemoryService {
  readonly ingested: Session[] = [];
  readonly searched: SearchMemoryRequest[] = [];
  readonly memories: MemoryEntry[] = [{content: {parts: [{text: 'recalled'}]}}];

  async addSessionToMemory(session: Session): Promise<void> {
    this.ingested.push(session);
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    this.searched.push(request);
    return {memories: this.memories};
  }
}

function makeAuthConfig(): AuthConfig {
  return {
    credentialKey: 'test-credential-key',
    authScheme: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Api-Key',
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'raw-key',
    },
  };
}

describe('Context — ported from adk-python tests/unittests/agents/test_context.py', () => {
  it('test_context_branch_returns_invocation_branch', () => {
    const context = new Context({
      invocationContext: makeInvocationContext({branch: 'test-branch'}),
    });

    expect(context.branch).toBe('test-branch');
  });

  describe('TestContextInitialization', () => {
    it('test_initialization_without_function_call_id', () => {
      const invocationContext = makeInvocationContext();
      const context = new Context({invocationContext});

      expect(context.invocationContext).toBe(invocationContext);
      expect(context.eventActions).toBeDefined();
      expect(context.state).toBeDefined();
      expect(context.functionCallId).toBeUndefined();
      expect(context.toolConfirmation).toBeUndefined();
    });

    it('test_initialization_with_function_call_id', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
        functionCallId: 'test-function-call-id',
      });

      expect(context.functionCallId).toBe('test-function-call-id');
      expect(context.toolConfirmation).toBeUndefined();
    });

    it('test_initialization_with_tool_confirmation', () => {
      const toolConfirmation = new ToolConfirmation({
        hint: 'test hint',
        confirmed: false,
        payload: {key: 'value'},
      });
      const context = new Context({
        invocationContext: makeInvocationContext(),
        functionCallId: 'test-function-call-id',
        toolConfirmation,
      });

      expect(context.functionCallId).toBe('test-function-call-id');
      expect(context.toolConfirmation).toBe(toolConfirmation);
      expect(context.toolConfirmation?.hint).toBe('test hint');
      expect(context.toolConfirmation?.payload).toEqual({key: 'value'});
    });

    /**
     * adk-js divergence: Python exposes a `function_call_id` setter, so the
     * property is mutable there too.
     */
    it('function_call_id setter assigns the id after construction', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      context.functionCallId = 'assigned-later';

      expect(context.functionCallId).toBe('assigned-later');
    });

    it('test_state_property', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(context.state.get('key1')).toBe('value1');
      expect(context.state.get('key2')).toBe('value2');
    });

    it('test_actions_property', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(context.actions).toBe(context.eventActions);
    });
  });

  describe('TestContextListArtifacts', () => {
    it('test_list_artifacts_returns_artifact_keys', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });

      await expect(context.listArtifacts()).resolves.toEqual([
        'file1.txt',
        'file2.txt',
        'file3.txt',
      ]);
    });

    it('test_list_artifacts_raises_value_error_when_service_is_none', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.listArtifacts()).toThrowError(
        'Artifact service is not initialized.',
      );
    });
  });

  describe('TestContextSaveLoadArtifact', () => {
    it('test_save_artifact', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });
      const artifact: Part = {text: 'test content'};

      const version = await context.saveArtifact('test_file.txt', artifact);

      expect(version).toBe(1);
      expect(artifactService.saved).toEqual([
        {
          filename: 'test_file.txt',
          artifact,
          customMetadata: undefined,
        },
      ]);
      expect(context.actions.artifactDelta['test_file.txt']).toBe(1);
    });

    it('test_save_artifact forwards customMetadata', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });
      const artifact: Part = {text: 'test content'};

      await context.saveArtifact('test_file.txt', artifact, {origin: 'tool'});

      expect(artifactService.saved[0].customMetadata).toEqual({
        origin: 'tool',
      });
    });

    it('test_save_artifact_raises_value_error_when_service_is_none', async () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      const artifact: Part = {text: 'x'};

      await expect(
        context.saveArtifact('test_file.txt', artifact),
      ).rejects.toThrowError('Artifact service is not initialized.');
    });

    it('test_load_artifact', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });

      const result = await context.loadArtifact('test_file.txt');

      expect(result).toBe(artifactService.stored);
      expect(artifactService.loaded).toEqual([
        {filename: 'test_file.txt', version: undefined},
      ]);
    });

    it('test_load_artifact_with_version', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });

      await context.loadArtifact('test_file.txt', 2);

      expect(artifactService.loaded).toEqual([
        {filename: 'test_file.txt', version: 2},
      ]);
    });

    it('test_load_artifact_raises_value_error_when_service_is_none', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.loadArtifact('test_file.txt')).toThrowError(
        'Artifact service is not initialized.',
      );
    });

    it('test_get_artifact_version', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });

      const result = await context.getArtifactVersion('test_file.txt', 2);

      expect(result).toBe(artifactService.version);
      expect(artifactService.versionsRequested).toEqual([
        {filename: 'test_file.txt', version: 2},
      ]);
    });

    it('test_get_artifact_version_defaults_to_latest', async () => {
      const artifactService = new RecordingArtifactService();
      const context = new Context({
        invocationContext: makeInvocationContext({artifactService}),
      });

      await context.getArtifactVersion('test_file.txt');

      expect(artifactService.versionsRequested).toEqual([
        {filename: 'test_file.txt', version: undefined},
      ]);
    });

    it('test_get_artifact_version_raises_value_error_when_service_is_none', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.getArtifactVersion('test_file.txt')).toThrowError(
        'Artifact service is not initialized.',
      );
    });
  });

  describe('TestContextCredentialMethods', () => {
    it('test_save_credential_with_service', async () => {
      const credentialService = new RecordingCredentialService();
      const context = new Context({
        invocationContext: makeInvocationContext({credentialService}),
      });
      const authConfig = makeAuthConfig();

      await context.saveCredential(authConfig);

      expect(credentialService.saved).toEqual([{authConfig, context}]);
    });

    it('test_save_credential_no_service', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.saveCredential(makeAuthConfig())).toThrowError(
        'Credential service is not initialized.',
      );
    });

    it('test_load_credential_with_service', async () => {
      const credentialService = new RecordingCredentialService();
      const context = new Context({
        invocationContext: makeInvocationContext({credentialService}),
      });
      const authConfig = makeAuthConfig();

      const result = await context.loadCredential(authConfig);

      expect(result).toBe(credentialService.credential);
      expect(credentialService.loadedFor).toEqual([{authConfig, context}]);
    });

    it('test_load_credential_no_service', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.loadCredential(makeAuthConfig())).toThrowError(
        'Credential service is not initialized.',
      );
    });
  });

  describe('TestContextGetAuthResponse', () => {
    it('test_get_auth_response', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });
      const authConfig = makeAuthConfig();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'stored-key',
      };
      context.state.set(`temp:${authConfig.credentialKey}`, credential);

      expect(context.getAuthResponse(authConfig)).toEqual(credential);
    });
  });

  describe('TestContextRequestCredential', () => {
    it('test_request_credential_with_function_call_id', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
        functionCallId: 'test-function-call-id',
      });
      const authConfig = makeAuthConfig();

      context.requestCredential(authConfig);

      expect(
        context.actions.requestedAuthConfigs['test-function-call-id'],
      ).toBeDefined();
    });

    /**
     * adk-js divergence: the message is `functionCallId is not set.` where
     * Python says `request_credential requires function_call_id`. Existing
     * adk-js tests assert this wording, so it is kept.
     */
    it('test_request_credential_without_function_call_id_raises', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.requestCredential(makeAuthConfig())).toThrowError(
        'functionCallId is not set.',
      );
    });
  });

  describe('TestContextRequestConfirmation', () => {
    it('test_request_confirmation_with_function_call_id', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
        functionCallId: 'test-function-call-id',
      });

      context.requestConfirmation({
        hint: 'Please confirm',
        payload: {action: 'delete'},
      });

      const confirmation =
        context.actions.requestedToolConfirmations['test-function-call-id'];
      expect(confirmation.hint).toBe('Please confirm');
      expect(confirmation.payload).toEqual({action: 'delete'});
    });

    it('test_request_confirmation_with_only_hint', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
        functionCallId: 'test-function-call-id',
      });

      context.requestConfirmation({hint: 'Confirm this action'});

      const confirmation =
        context.actions.requestedToolConfirmations['test-function-call-id'];
      expect(confirmation.hint).toBe('Confirm this action');
      expect(confirmation.payload).toBeUndefined();
    });

    /** adk-js divergence on wording; see the request_credential note above. */
    it('test_request_confirmation_without_function_call_id_raises', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.requestConfirmation({})).toThrowError(
        'functionCallId is not set.',
      );
    });
  });

  describe('TestContextMemoryMethods', () => {
    it('test_add_session_to_memory_success', async () => {
      const memoryService = new RecordingMemoryService();
      const invocationContext = makeInvocationContext({memoryService});
      const context = new Context({invocationContext});

      await context.addSessionToMemory();

      expect(memoryService.ingested).toEqual([invocationContext.session]);
    });

    it('test_add_session_to_memory_no_service_raises', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.addSessionToMemory()).toThrowError(
        'Cannot add session to memory: memory service is not available.',
      );
    });

    it('test_search_memory_success', async () => {
      const memoryService = new RecordingMemoryService();
      const context = new Context({
        invocationContext: makeInvocationContext({memoryService}),
      });

      const result = await context.searchMemory('test query');

      expect(result.memories).toBe(memoryService.memories);
      expect(memoryService.searched).toEqual([
        {appName: 'test-app', userId: 'test-user', query: 'test query'},
      ]);
    });

    /** adk-js wording: `Memory service is not initialized.` */
    it('test_search_memory_no_service_raises', () => {
      const context = new Context({
        invocationContext: makeInvocationContext(),
      });

      expect(() => context.searchMemory('test query')).toThrowError(
        'Memory service is not initialized.',
      );
    });
  });
});
