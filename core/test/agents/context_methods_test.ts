/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `main`,
 * `tests/unittests/agents/test_context.py` — the classes covering `Context`
 * behaviour that adk-js already had but never tested directly:
 * `TestContextInitialization`, `TestContextListArtifacts`,
 * `TestContextSaveLoadArtifact`, `TestContextGetAuthResponse`,
 * `TestContextRequestCredential`, `TestContextRequestConfirmation`, the
 * `search_memory` half of `TestContextMemoryMethods`, and the module-level
 * branch test. The ported cases keep their Python names verbatim so a reviewer
 * can grep across the two repositories.
 *
 * The file is named `context_methods_test.ts` rather than `context_test.ts`
 * because a `context_test.ts` already exists on the `parity` branch, covering
 * `renderUiWidget`, `customMetadata` and the state schema.
 */

import {
  ArtifactVersion,
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  BaseMemoryService,
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SearchMemoryResponse,
  Session,
  SessionArtifactService,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

const ARTIFACT: Part = {text: 'test content'};

/** Records the calls it was given, without a backing store. */
class RecordingArtifactService implements SessionArtifactService {
  readonly saved: Array<{filename: string; artifact: Part}> = [];
  readonly loaded: Array<{filename: string; version?: number}> = [];
  listCalls = 0;

  async saveArtifact(args: {
    filename: string;
    artifact: Part;
  }): Promise<number> {
    this.saved.push(args);
    return 1;
  }

  async loadArtifact(args: {
    filename: string;
    version?: number;
  }): Promise<Part | undefined> {
    this.loaded.push(args);
    return ARTIFACT;
  }

  async listArtifactKeys(): Promise<string[]> {
    this.listCalls += 1;
    return ['file1.txt', 'file2.txt', 'file3.txt'];
  }

  async deleteArtifact(): Promise<void> {}

  async listVersions(): Promise<number[]> {
    return [1];
  }

  async listArtifactVersions(): Promise<ArtifactVersion[]> {
    return [];
  }

  async getArtifactVersion(): Promise<ArtifactVersion | undefined> {
    return undefined;
  }
}

/** Records the search it was asked for and answers with a fixed response. */
class RecordingMemoryService implements BaseMemoryService {
  readonly searches: Array<{appName: string; userId: string; query: string}> =
    [];

  async addSessionToMemory(): Promise<void> {}

  async searchMemory(args: {
    appName: string;
    userId: string;
    query: string;
  }): Promise<SearchMemoryResponse> {
    this.searches.push(args);
    return {memories: []};
  }
}

function makeSession(): Session {
  return createSession({
    id: 'test-session-id',
    appName: 'test-app',
    userId: 'test-user',
    state: {key1: 'value1', key2: 'value2'},
    lastUpdateTime: Date.now(),
  });
}

function makeInvocationContext(
  options: {
    artifactService?: SessionArtifactService;
    memoryService?: BaseMemoryService;
  } = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    agent: new LlmAgent({name: 'test_agent_name'}),
    session: makeSession(),
    pluginManager: new PluginManager(),
    branch: 'test-branch',
    ...options,
  });
}

const AUTH_CONFIG: AuthConfig = {
  authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
  credentialKey: 'api-key-credential',
};

it('test_context_branch_returns_invocation_branch', () => {
  const invocationContext = makeInvocationContext();

  expect(new Context({invocationContext}).branch).toBe('test-branch');
});

describe('Context initialization', () => {
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

  it('test_state_property', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(context.state.get('key1')).toBe('value1');
    expect(context.state.get('key2')).toBe('value2');
  });

  it('test_actions_property', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(context.actions).toBe(context.eventActions);
  });
});

describe('Context.listArtifacts', () => {
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
    expect(artifactService.listCalls).toBe(1);
  });

  it('test_list_artifacts_raises_value_error_when_service_is_none', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(() => context.listArtifacts()).toThrow(
      'Artifact service is not initialized.',
    );
  });
});

describe('Context save and load artifact', () => {
  it('test_save_artifact', async () => {
    const artifactService = new RecordingArtifactService();
    const context = new Context({
      invocationContext: makeInvocationContext({artifactService}),
    });

    const version = await context.saveArtifact('test_file.txt', ARTIFACT);

    expect(version).toBe(1);
    expect(artifactService.saved).toEqual([
      {filename: 'test_file.txt', artifact: ARTIFACT},
    ]);
    expect(context.actions.artifactDelta['test_file.txt']).toBe(1);
  });

  it('test_load_artifact', async () => {
    const artifactService = new RecordingArtifactService();
    const context = new Context({
      invocationContext: makeInvocationContext({artifactService}),
    });

    await expect(context.loadArtifact('test_file.txt')).resolves.toBe(ARTIFACT);
    expect(artifactService.loaded).toEqual([
      {filename: 'test_file.txt', version: undefined},
    ]);
  });

  it('test_load_artifact_with_version', async () => {
    const artifactService = new RecordingArtifactService();
    const context = new Context({
      invocationContext: makeInvocationContext({artifactService}),
    });

    await expect(context.loadArtifact('test_file.txt', 2)).resolves.toBe(
      ARTIFACT,
    );
    expect(artifactService.loaded).toEqual([
      {filename: 'test_file.txt', version: 2},
    ]);
  });

  it('refuses to save without an artifact service', async () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    await expect(
      context.saveArtifact('test_file.txt', ARTIFACT),
    ).rejects.toThrow('Artifact service is not initialized.');
  });

  it('refuses to load without an artifact service', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(() => context.loadArtifact('test_file.txt')).toThrow(
      'Artifact service is not initialized.',
    );
  });
});

describe('Context.getAuthResponse', () => {
  it('test_get_auth_response', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored-key',
    };
    const context = new Context({invocationContext: makeInvocationContext()});
    // `AuthHandler` reads the response back out of session state, keyed by the
    // config's credential key.
    context.state.set(`temp:${AUTH_CONFIG.credentialKey}`, credential);

    expect(context.getAuthResponse(AUTH_CONFIG)).toEqual(credential);
  });

  it('resolves to undefined when state holds no response', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(context.getAuthResponse(AUTH_CONFIG)).toBeUndefined();
  });
});

describe('Context.requestCredential', () => {
  it('test_request_credential_with_function_call_id', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
      functionCallId: 'test-function-call-id',
    });

    context.requestCredential(AUTH_CONFIG);

    expect(
      context.actions.requestedAuthConfigs['test-function-call-id'],
    ).toBeDefined();
  });

  it('test_request_credential_without_function_call_id_raises', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(() => context.requestCredential(AUTH_CONFIG)).toThrow(
      'functionCallId is not set.',
    );
  });
});

describe('Context.requestConfirmation', () => {
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

  it('test_request_confirmation_without_function_call_id_raises', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(() => context.requestConfirmation({})).toThrow(
      'functionCallId is not set.',
    );
  });
});

describe('Context.searchMemory', () => {
  it('test_search_memory_success', async () => {
    const memoryService = new RecordingMemoryService();
    const context = new Context({
      invocationContext: makeInvocationContext({memoryService}),
    });

    await expect(context.searchMemory('test query')).resolves.toEqual({
      memories: [],
    });
    expect(memoryService.searches).toEqual([
      {appName: 'test-app', userId: 'test-user', query: 'test query'},
    ]);
  });

  it('test_search_memory_no_service_raises', () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    expect(() => context.searchMemory('test query')).toThrow(
      'Memory service is not initialized.',
    );
  });
});
