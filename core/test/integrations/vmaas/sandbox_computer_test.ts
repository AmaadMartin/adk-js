/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-js paths of AgentEngineSandboxComputer that adk-python's suite does
 * not reach: the two injected transports, the create-operation polling, and the
 * typed failures.
 */

import {AgentEngineSandboxOperation} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  AgentEngineSandboxComputer,
  AgentEngineSandboxComputerOptions,
  SandboxError,
  SandboxErrorCode,
  isSandboxError,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  ACCESS_TOKEN,
  AGENT_ENGINE_NAME,
  SANDBOX_NAME,
  SERVICE_ACCOUNT,
  SNAPSHOT_NAME,
  TEMPLATE_NAME,
  createFakeSandbox,
  createFakeTokenProvider,
  createFakeVertexApi,
  createTestContext,
} from './vmaas_test_utils.js';

const STATE_KEY_ACCESS_TOKEN = '_vmaas_access_token';
const STATE_KEY_TOKEN_EXPIRY = '_vmaas_token_expiry';

/** A computer wired to the fakes, with its session state already bound. */
async function createPreparedComputer(
  options: Partial<AgentEngineSandboxComputerOptions> = {},
) {
  const vertexApi = createFakeVertexApi();
  const sandbox = createFakeSandbox();
  const accessTokenProvider = createFakeTokenProvider();
  const computer = new AgentEngineSandboxComputer({
    projectId: 'test-project',
    vertexaiClient: vertexApi,
    accessTokenProvider,
    sendCommand: sandbox.sendCommand,
    ...options,
  });
  const context = createTestContext();
  await computer.prepare(context);
  return {computer, vertexApi, sandbox, accessTokenProvider, context};
}

/** The create-sandbox request the fake Vertex AI client received. */
function sandboxCreateRequest(
  vertexApi: ReturnType<typeof createFakeVertexApi>,
) {
  const [request] =
    vertexApi.agentEnginesInternal.sandboxes.createInternal.mock.calls[0];
  return request;
}

/** Reports the failure a rejected call carried, for a typed assertion. */
async function captureError(call: Promise<unknown>): Promise<SandboxError> {
  try {
    await call;
  } catch (e: unknown) {
    if (isSandboxError(e)) {
      return e;
    }
    expect.fail(`Expected a SandboxError, got ${String(e)}`);
  }
  expect.fail('Expected the call to fail.');
}

describe('AgentEngineSandboxComputer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('access token', () => {
    it('clears the shared token and retries once when minting fails', async () => {
      const context = createTestContext();
      context.state.set(STATE_KEY_ACCESS_TOKEN, 'revoked-token');
      context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 - 1);
      const stateOnRetry: Array<{token?: string; expiry?: number}> = [];
      const accessTokenProvider = vi
        .fn(async () => {
          stateOnRetry.push({
            token: context.state.get<string>(STATE_KEY_ACCESS_TOKEN),
            expiry: context.state.get<number>(STATE_KEY_TOKEN_EXPIRY),
          });
          return 'fresh-token';
        })
        .mockRejectedValueOnce(new Error('the token service is down'));
      const retrying = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: createFakeVertexApi(),
        accessTokenProvider,
        sendCommand: createFakeSandbox().sendCommand,
      });
      await retrying.prepare(context);

      await retrying.currentState();

      expect(accessTokenProvider).toHaveBeenCalledTimes(2);
      // The retry ran against a cleared cache, not the revoked token.
      expect(stateOnRetry).toEqual([{token: undefined, expiry: 0}]);
      expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe('fresh-token');
    });

    it('reports the second failure when minting fails twice', async () => {
      const accessTokenProvider = vi
        .fn()
        .mockRejectedValue(new Error('the token service is down'));
      const {computer} = await createPreparedComputer({
        sandboxName: SANDBOX_NAME,
        accessTokenProvider,
      });

      await expect(computer.currentState()).rejects.toThrow(
        'the token service is down',
      );
      expect(accessTokenProvider).toHaveBeenCalledTimes(2);
    });

    it('mints a new token when the cached one expires inside the buffer', async () => {
      const {computer, accessTokenProvider, context} =
        await createPreparedComputer({sandboxName: SANDBOX_NAME});
      context.state.set(STATE_KEY_ACCESS_TOKEN, 'nearly-expired');
      context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 + 30);

      await computer.currentState();

      expect(accessTokenProvider).toHaveBeenCalled();
      expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe(ACCESS_TOKEN);
    });

    it('keeps a cached token that outlives the buffer', async () => {
      const {computer, accessTokenProvider, context} =
        await createPreparedComputer({sandboxName: SANDBOX_NAME});
      context.state.set(STATE_KEY_ACCESS_TOKEN, 'still-valid');
      context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 + 120);

      await computer.currentState();

      expect(accessTokenProvider).not.toHaveBeenCalled();
    });

    it('records an expiry one token lifetime ahead', async () => {
      const {computer, context} = await createPreparedComputer({
        sandboxName: SANDBOX_NAME,
      });
      const before = Date.now() / 1000;

      await computer.currentState();

      const expiry = context.state.get<number>(STATE_KEY_TOKEN_EXPIRY) ?? 0;
      expect(expiry).toBeGreaterThanOrEqual(before + 3600);
      expect(expiry).toBeLessThan(before + 3610);
    });

    it('passes the service account to the token provider', async () => {
      const {computer, accessTokenProvider} = await createPreparedComputer({
        sandboxName: SANDBOX_NAME,
        serviceAccountEmail: SERVICE_ACCOUNT,
      });

      await computer.currentState();

      expect(accessTokenProvider).toHaveBeenCalledWith({
        sandboxName: SANDBOX_NAME,
        serviceAccountEmail: SERVICE_ACCOUNT,
        timeoutSeconds: 3600,
      });
    });
  });

  describe('sandbox creation', () => {
    it('asks for a computer use environment when no source is named', async () => {
      const {computer, vertexApi} = await createPreparedComputer();

      await computer.currentState();

      expect(sandboxCreateRequest(vertexApi)).toEqual({
        name: AGENT_ENGINE_NAME,
        spec: {computerUseEnvironment: {}},
        config: {displayName: 'adk_computer_use_sandbox', ttl: '3600s'},
      });
    });

    it('builds the sandbox from a template', async () => {
      const {computer, vertexApi} = await createPreparedComputer({
        sandboxTemplateName: TEMPLATE_NAME,
      });

      await computer.currentState();

      expect(sandboxCreateRequest(vertexApi)).toEqual({
        name: AGENT_ENGINE_NAME,
        spec: undefined,
        config: {
          displayName: 'adk_computer_use_sandbox',
          ttl: '3600s',
          httpOptions: {
            extraBody: {sandboxEnvironmentTemplate: TEMPLATE_NAME},
          },
        },
      });
    });

    it('restores the sandbox from a snapshot', async () => {
      const {computer, vertexApi} = await createPreparedComputer({
        sandboxSnapshotName: SNAPSHOT_NAME,
      });

      await computer.currentState();

      expect(sandboxCreateRequest(vertexApi).config).toEqual({
        displayName: 'adk_computer_use_sandbox',
        ttl: '3600s',
        httpOptions: {
          extraBody: {sandboxEnvironmentSnapshot: SNAPSHOT_NAME},
        },
      });
    });

    it('prefers the template over the snapshot', async () => {
      const {computer, vertexApi} = await createPreparedComputer({
        sandboxTemplateName: TEMPLATE_NAME,
        sandboxSnapshotName: SNAPSHOT_NAME,
      });

      await computer.currentState();

      expect(sandboxCreateRequest(vertexApi).config?.httpOptions).toEqual({
        extraBody: {sandboxEnvironmentTemplate: TEMPLATE_NAME},
      });
    });

    it('asks for the configured time to live', async () => {
      const {computer, vertexApi} = await createPreparedComputer({
        sandboxTtlSeconds: 900,
      });

      await computer.currentState();

      expect(sandboxCreateRequest(vertexApi).config?.ttl).toBe('900s');
    });
  });

  describe('create operations', () => {
    it('polls a sandbox operation until it reports itself done', async () => {
      const {computer, vertexApi} = await createPreparedComputer();
      const pending: AgentEngineSandboxOperation = {
        name: 'operations/create-sandbox',
        done: false,
      };
      vertexApi.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        pending,
      );
      vertexApi.agentEnginesInternal.sandboxes.getSandboxOperationInternal
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({
          name: 'operations/create-sandbox',
          done: true,
          response: {name: SANDBOX_NAME},
        });
      vi.useFakeTimers();

      const state = computer.currentState();
      await vi.advanceTimersByTimeAsync(3000);

      await expect(state).resolves.toBeDefined();
      expect(
        vertexApi.agentEnginesInternal.sandboxes.getSandboxOperationInternal,
      ).toHaveBeenCalledTimes(3);
    });

    it('reports a sandbox operation that never finishes', async () => {
      const {computer, vertexApi} = await createPreparedComputer();
      vertexApi.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        {
          name: 'operations/create-sandbox',
          done: false,
        },
      );
      vertexApi.agentEnginesInternal.sandboxes.getSandboxOperationInternal.mockResolvedValue(
        {name: 'operations/create-sandbox', done: false},
      );
      vi.useFakeTimers();

      const failing = captureError(computer.currentState());
      await vi.advanceTimersByTimeAsync(180_000);

      const error = await failing;
      expect(error.code).toBe(SandboxErrorCode.CREATE_OPERATION_INCOMPLETE);
      expect(error.message).toContain('sandbox');
      expect(
        vertexApi.agentEnginesInternal.sandboxes.getSandboxOperationInternal,
      ).toHaveBeenCalledTimes(180);
    });

    it('reports an agent engine operation that never finishes', async () => {
      const {computer, vertexApi} = await createPreparedComputer();
      vertexApi.agentEnginesInternal.createInternal.mockResolvedValue({
        name: 'operations/create-engine',
        done: false,
      });
      vertexApi.agentEnginesInternal.getAgentOperationInternal.mockResolvedValue(
        {name: 'operations/create-engine', done: false},
      );
      vi.useFakeTimers();

      const failing = captureError(computer.currentState());
      await vi.advanceTimersByTimeAsync(180_000);

      const error = await failing;
      expect(error.code).toBe(SandboxErrorCode.CREATE_OPERATION_INCOMPLETE);
      expect(error.message).toContain('agent engine');
    });

    it('reports a finished operation whose sandbox name is empty', async () => {
      const {computer, vertexApi} = await createPreparedComputer();
      vertexApi.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        {
          name: 'operations/create-sandbox',
          done: true,
          response: {name: ''},
        },
      );

      const error = await captureError(computer.currentState());

      expect(error.code).toBe(SandboxErrorCode.CREATED_RESOURCE_UNNAMED);
    });

    it('reports an unfinished operation that cannot be polled', async () => {
      const {computer, vertexApi} = await createPreparedComputer();
      vertexApi.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        {done: false},
      );
      vi.useFakeTimers();

      const failing = captureError(computer.currentState());
      await vi.advanceTimersByTimeAsync(1000);

      const error = await failing;
      expect(error.code).toBe(SandboxErrorCode.CREATE_OPERATION_UNNAMED);
      expect(
        vertexApi.agentEnginesInternal.sandboxes.getSandboxOperationInternal,
      ).not.toHaveBeenCalled();
    });

    it('reports a finished operation that names no sandbox', async () => {
      const {computer, vertexApi} = await createPreparedComputer();
      vertexApi.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        {
          name: 'operations/create-sandbox',
          done: true,
          response: {displayName: 'no name here'},
        },
      );

      const error = await captureError(computer.currentState());

      expect(error.code).toBe(SandboxErrorCode.CREATED_RESOURCE_UNNAMED);
    });
  });

  describe('configuration failures', () => {
    it('refuses to act before prepare bound the session state', async () => {
      const computer = new AgentEngineSandboxComputer({
        vertexaiClient: createFakeVertexApi(),
        accessTokenProvider: createFakeTokenProvider(),
        sendCommand: createFakeSandbox().sendCommand,
      });

      const error = await captureError(computer.currentState());

      expect(error.code).toBe(SandboxErrorCode.SESSION_STATE_NOT_BOUND);
    });

    it('refuses to act without a token provider', async () => {
      const computer = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: createFakeVertexApi(),
        sendCommand: createFakeSandbox().sendCommand,
      });
      await computer.prepare(createTestContext());

      const error = await captureError(computer.currentState());

      expect(error.code).toBe(SandboxErrorCode.TRANSPORT_NOT_CONFIGURED);
      expect(error.message).toContain('accessTokenProvider');
    });

    it('refuses to act without a command transport', async () => {
      const vertexApi = createFakeVertexApi();
      const computer = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: vertexApi,
        accessTokenProvider: createFakeTokenProvider(),
      });
      await computer.prepare(createTestContext());

      const error = await captureError(computer.currentState());

      expect(error.code).toBe(SandboxErrorCode.TRANSPORT_NOT_CONFIGURED);
      expect(error.message).toContain('sendCommand');
      // The transport is read before anything is created in the project.
      expect(
        vertexApi.agentEnginesInternal.sandboxes.getInternal,
      ).not.toHaveBeenCalled();
    });
  });

  describe('agent engine derivation', () => {
    it('ignores a resource name that names no reasoning engine', () => {
      const computer = new AgentEngineSandboxComputer({
        sandboxName: 'projects/test/locations/us/sandboxEnvironments/456',
      });

      expect(computer.agentEngineName).toBeUndefined();
    });

    it('ignores a resource name with no sandbox segment', () => {
      const computer = new AgentEngineSandboxComputer({
        sandboxName: AGENT_ENGINE_NAME,
      });

      expect(computer.agentEngineName).toBeUndefined();
    });

    it('falls back to the snapshot when the template names no engine', () => {
      const computer = new AgentEngineSandboxComputer({
        sandboxTemplateName: 'sandboxEnvironmentTemplates/789',
        sandboxSnapshotName: SNAPSHOT_NAME,
      });

      expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    });
  });

  describe('actions', () => {
    it('presses enter and clears the field unless told otherwise', async () => {
      const {computer, sandbox} = await createPreparedComputer();

      await computer.typeTextAt({x: 1, y: 2, text: 'hello'});

      const [, typing] = sandbox
        .bodiesTo('cdps')
        .map((body) => body?.['commands']);
      // Four clearing commands, the text, then two for Enter.
      expect(typing).toHaveLength(7);
    });

    it('searches the default search engine', async () => {
      const {computer, sandbox} = await createPreparedComputer();

      await computer.search();

      expect(sandbox.bodiesTo('cdp')[0]).toEqual({
        command: 'Page.navigate',
        params: {url: 'https://www.google.com'},
      });
    });
  });
});
