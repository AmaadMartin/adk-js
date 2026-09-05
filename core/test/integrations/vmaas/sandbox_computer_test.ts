/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the `AgentEngineSandboxComputer` behaviour the adk-python
 * reference suite does not reach: the unbound-state guard, the token retry,
 * the create-sandbox branches, the missing transport seams and the failure
 * paths of agent engine creation.
 */

import {
  AgentEngineSandboxComputer,
  SandboxErrorCode,
  isSandboxError,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {
  AGENT_ENGINE_NAME,
  SANDBOX_NAME,
  asVertexClient,
  createFakeSandbox,
  createMockVertexClient,
  createTestContext,
} from './vmaas_test_utils.js';

const TEMPLATE_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironmentTemplates/789`;
const SNAPSHOT_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironmentSnapshots/789`;
const STATE_KEY_ACCESS_TOKEN = '_vmaas_access_token';
const STATE_KEY_TOKEN_EXPIRY = '_vmaas_token_expiry';
const STATE_KEY_SANDBOX_NAME = '_vmaas_sandbox_name';

/** The code of `error`, or `undefined` when it is not a sandbox error. */
function sandboxErrorCode(error: unknown): SandboxErrorCode | undefined {
  return isSandboxError(error) ? error.code : undefined;
}

describe('AgentEngineSandboxComputer', () => {
  describe('session state', () => {
    it('refuses to act before prepare() binds the state', async () => {
      const computer = new AgentEngineSandboxComputer({
        vertexaiClient: asVertexClient(createMockVertexClient()),
        accessTokenProvider: vi.fn(),
        sendCommand: createFakeSandbox().sendCommand,
      });

      const error = await computer.currentState().catch((e: unknown) => e);

      expect(sandboxErrorCode(error)).toBe(
        SandboxErrorCode.SESSION_STATE_NOT_BOUND,
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('prepare()'),
      );
    });

    it('shares the created sandbox between two computers on one state', async () => {
      const context = createTestContext();
      const vertexClient = createMockVertexClient();
      const options = {
        vertexaiClient: asVertexClient(vertexClient),
        accessTokenProvider: vi.fn().mockResolvedValue('token'),
        sendCommand: createFakeSandbox().sendCommand,
      };
      const first = new AgentEngineSandboxComputer(options);
      const second = new AgentEngineSandboxComputer(options);
      await first.prepare(context);
      await second.prepare(context);

      await first.currentState();
      await second.currentState();

      expect(
        vertexClient.agentEnginesInternal.createInternal,
      ).toHaveBeenCalledTimes(1);
      expect(
        vertexClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalledTimes(1);
      expect(context.state.get(STATE_KEY_SANDBOX_NAME)).toBe(SANDBOX_NAME);
    });
  });

  describe('access token', () => {
    /** A computer whose token provider is under the test's control. */
    async function withProvider(provider: ReturnType<typeof vi.fn>) {
      const context = createTestContext();
      const sandbox = createFakeSandbox();
      const computer = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: asVertexClient(createMockVertexClient()),
        accessTokenProvider: provider,
        sendCommand: sandbox.sendCommand,
      });
      await computer.prepare(context);
      return {computer, context, sandbox};
    }

    it('clears the cached token and retries once after a failure', async () => {
      let stateDuringRetry: {token?: string; expiry?: number} | undefined;
      const provider = vi
        .fn()
        .mockRejectedValueOnce(new Error('minting failed'));
      const {computer, context, sandbox} = await withProvider(provider);
      provider.mockImplementation(async () => {
        stateDuringRetry = {
          token: context.state.get<string>(STATE_KEY_ACCESS_TOKEN),
          expiry: context.state.get<number>(STATE_KEY_TOKEN_EXPIRY),
        };
        return 'fresh_token';
      });
      context.state.set(STATE_KEY_ACCESS_TOKEN, 'stale_token');
      context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 - 1);

      await computer.currentState();

      expect(provider).toHaveBeenCalledTimes(2);
      expect(stateDuringRetry).toEqual({token: undefined, expiry: 0});
      expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe('fresh_token');
      expect(sandbox.calls[0].accessToken).toBe('fresh_token');
    });

    it('propagates a second token failure', async () => {
      const provider = vi.fn().mockRejectedValue(new Error('still failing'));
      const {computer} = await withProvider(provider);

      await expect(computer.currentState()).rejects.toThrow('still failing');
      expect(provider).toHaveBeenCalledTimes(2);
    });

    it('refreshes a token that expires inside the buffer window', async () => {
      const provider = vi.fn().mockResolvedValue('fresh_token');
      const {computer, context} = await withProvider(provider);
      context.state.set(STATE_KEY_ACCESS_TOKEN, 'about_to_expire');
      context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 + 30);

      await computer.currentState();

      expect(provider).toHaveBeenCalled();
      expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe('fresh_token');
    });

    it('treats a session with no recorded expiry as expired', async () => {
      const provider = vi.fn().mockResolvedValue('fresh_token');
      const {computer, context} = await withProvider(provider);
      context.state.set(STATE_KEY_ACCESS_TOKEN, 'token_from_another_sdk');
      context.state.set(STATE_KEY_TOKEN_EXPIRY, undefined);

      await computer.currentState();

      expect(provider).toHaveBeenCalled();
      expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe('fresh_token');
    });

    it('records an expiry one token lifetime ahead', async () => {
      const provider = vi.fn().mockResolvedValue('fresh_token');
      const {computer, context} = await withProvider(provider);
      const before = Date.now() / 1000;

      await computer.currentState();

      const expiry = context.state.get<number>(STATE_KEY_TOKEN_EXPIRY)!;
      expect(expiry).toBeGreaterThanOrEqual(before + 3600);
      expect(provider).toHaveBeenCalledWith({
        sandboxName: SANDBOX_NAME,
        serviceAccountEmail: undefined,
        timeoutSeconds: 3600,
      });
    });
  });

  describe('missing transport seams', () => {
    it('names the missing access token method', async () => {
      const computer = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: asVertexClient(createMockVertexClient()),
        sendCommand: createFakeSandbox().sendCommand,
      });
      await computer.prepare(createTestContext());

      const error = await computer.currentState().catch((e: unknown) => e);

      expect(sandboxErrorCode(error)).toBe(
        SandboxErrorCode.SDK_TRANSPORT_UNAVAILABLE,
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('generateAccessToken'),
      );
    });

    it('names the missing send command method', async () => {
      const computer = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: asVertexClient(createMockVertexClient()),
        accessTokenProvider: vi.fn().mockResolvedValue('token'),
      });
      await computer.prepare(createTestContext());

      const error = await computer.currentState().catch((e: unknown) => e);

      expect(sandboxErrorCode(error)).toBe(
        SandboxErrorCode.SDK_TRANSPORT_UNAVAILABLE,
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('sendCommand'),
      );
    });
  });

  describe('sandbox creation', () => {
    /** Creates a sandbox and returns the create request the client received. */
    async function createRequestFor(
      options: {
        sandboxTemplateName?: string;
        sandboxSnapshotName?: string;
        sandboxTtlSeconds?: number;
      } = {},
    ) {
      const vertexClient = createMockVertexClient();
      const computer = new AgentEngineSandboxComputer({
        ...options,
        vertexaiClient: asVertexClient(vertexClient),
        accessTokenProvider: vi.fn().mockResolvedValue('token'),
        sendCommand: createFakeSandbox().sendCommand,
      });
      await computer.prepare(createTestContext());
      await computer.currentState();
      return vertexClient.agentEnginesInternal.sandboxes.createInternal.mock
        .calls[0][0];
    }

    it('asks for a computer use environment when there is no template', async () => {
      const request = await createRequestFor();

      expect(request).toEqual({
        name: AGENT_ENGINE_NAME,
        spec: {computerUseEnvironment: {}},
        config: {
          displayName: 'adk_computer_use_sandbox',
          ttl: '3600s',
          waitForCompletion: true,
        },
      });
    });

    it('prefers the template over the snapshot', async () => {
      const request = await createRequestFor({
        sandboxTemplateName: TEMPLATE_NAME,
        sandboxSnapshotName: SNAPSHOT_NAME,
      });

      expect(request.spec).toBeUndefined();
      expect(request.config).toMatchObject({
        sandboxEnvironmentTemplate: TEMPLATE_NAME,
      });
      expect(request.config).not.toHaveProperty('sandboxEnvironmentSnapshot');
    });

    it('starts from the snapshot when there is no template', async () => {
      const request = await createRequestFor({
        sandboxSnapshotName: SNAPSHOT_NAME,
      });

      expect(request.spec).toBeUndefined();
      expect(request.config).toMatchObject({
        sandboxEnvironmentSnapshot: SNAPSHOT_NAME,
      });
    });

    it('sends the configured time to live', async () => {
      const request = await createRequestFor({sandboxTtlSeconds: 60});

      expect(request.config).toMatchObject({ttl: '60s'});
    });

    it('reports a create operation that carried no sandbox name', async () => {
      const vertexClient = createMockVertexClient();
      vertexClient.agentEnginesInternal.sandboxes.createInternal.mockResolvedValue(
        {name: 'operations/create-sandbox-op', done: true, response: {}},
      );
      const computer = new AgentEngineSandboxComputer({
        vertexaiClient: asVertexClient(vertexClient),
        accessTokenProvider: vi.fn().mockResolvedValue('token'),
        sendCommand: createFakeSandbox().sendCommand,
      });
      await computer.prepare(createTestContext());

      const error = await computer.currentState().catch((e: unknown) => e);

      expect(sandboxErrorCode(error)).toBe(
        SandboxErrorCode.SANDBOX_NAME_MISSING,
      );
    });
  });

  describe('agent engine creation', () => {
    /** Drives a create with the given engine operation results. */
    async function createWith(operations: {
      create: Record<string, unknown>;
      poll?: Record<string, unknown>;
    }) {
      const vertexClient = createMockVertexClient();
      vertexClient.agentEnginesInternal.createInternal.mockResolvedValue(
        operations.create,
      );
      vertexClient.agentEnginesInternal.getAgentOperationInternal.mockResolvedValue(
        operations.poll ?? operations.create,
      );
      const computer = new AgentEngineSandboxComputer({
        vertexaiClient: asVertexClient(vertexClient),
        accessTokenProvider: vi.fn().mockResolvedValue('token'),
        sendCommand: createFakeSandbox().sendCommand,
      });
      await computer.prepare(createTestContext());
      return {computer, vertexClient};
    }

    it('polls until the operation finishes', async () => {
      const {computer, vertexClient} = await createWith({
        create: {name: 'operations/op', done: false},
        poll: {
          name: 'operations/op',
          done: true,
          response: {name: AGENT_ENGINE_NAME},
        },
      });

      await computer.currentState();

      expect(
        vertexClient.agentEnginesInternal.getAgentOperationInternal,
      ).toHaveBeenCalledWith({operationName: 'operations/op'});
      expect(
        vertexClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalledWith(
        expect.objectContaining({name: AGENT_ENGINE_NAME}),
      );
    }, 10000);

    it('gives up on an operation that never finishes', async () => {
      const {computer} = await createWith({
        create: {name: 'operations/op', done: false},
        poll: {name: 'operations/op', done: false},
      });

      vi.useFakeTimers();
      try {
        const pending = computer.currentState().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(180 * 1000);
        expect(sandboxErrorCode(await pending)).toBe(
          SandboxErrorCode.AGENT_ENGINE_CREATE_TIMED_OUT,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports an operation that finished without a resource name', async () => {
      const {computer} = await createWith({
        create: {name: 'operations/op', done: true, response: {}},
      });

      const error = await computer.currentState().catch((e: unknown) => e);

      expect(sandboxErrorCode(error)).toBe(
        SandboxErrorCode.AGENT_ENGINE_NAME_MISSING,
      );
    });
  });

  describe('typeTextAt', () => {
    it('clears the field and presses enter when the caller omits both', async () => {
      const sandbox = createFakeSandbox();
      const computer = new AgentEngineSandboxComputer({
        sandboxName: SANDBOX_NAME,
        vertexaiClient: asVertexClient(createMockVertexClient()),
        accessTokenProvider: vi.fn().mockResolvedValue('token'),
        sendCommand: sandbox.sendCommand,
      });
      await computer.prepare(createTestContext());

      await computer.typeTextAt({x: 1, y: 2, text: 'hello'});

      const batches = sandbox.calls
        .filter((call) => call.path === 'cdps')
        .map(
          (call) =>
            call.requestBody?.['commands'] as Array<{
              params: Record<string, unknown>;
            }>,
        );
      expect(batches[1].map((entry) => entry.params['key'])).toEqual([
        'A',
        'A',
        'Delete',
        'Delete',
        undefined,
        'Enter',
        'Enter',
      ]);
    });
  });
});
