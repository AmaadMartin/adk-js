/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {
  AgentEngineSandboxCodeExecutor,
  BaseAgent,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  CodeExecutionResponseProcessor,
} from '../../../src/agents/processors/code_execution_request_processor.js';
import {InMemoryArtifactService} from '../../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import {SessionArtifactService} from '../../../src/artifacts/session_artifact_service.js';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../../src/code_executors/base_code_executor.js';
import {CodeExecutionResult} from '../../../src/code_executors/code_execution_utils.js';

const AGENT_ENGINE_NAME =
  'projects/test-project/locations/us-central1/reasoningEngines/123';
const SANDBOX_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironments/456`;

class MockBaseAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

class TestCodeExecutor extends BaseCodeExecutor {
  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
  }
}

function createMockInvocationContext(
  agent: BaseAgent,
  artifactService?: SessionArtifactService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    artifactService,
  });
}

/**
 * A Client stub that reports every Agent Engine and sandbox operation as
 * already complete, so the executor runs without a poll loop.
 */
function createSandboxClient(): Client {
  const completedOperation = {
    name: 'operations/op',
    done: true,
    response: {name: SANDBOX_NAME},
  };
  const stub = {
    agentEnginesInternal: {
      createInternal: async () => ({
        name: 'operations/create-engine-op',
        done: true,
        response: {name: AGENT_ENGINE_NAME},
      }),
      sandboxes: {
        getInternal: async () => ({name: SANDBOX_NAME, state: 'STATE_RUNNING'}),
        createInternal: async () => completedOperation,
        executeCodeInternal: async () => ({
          outputs: [
            {
              mimeType: 'application/json',
              data: Buffer.from(
                JSON.stringify({msg_out: 'hi', msg_err: ''}),
              ).toString('base64'),
            },
          ],
        }),
      },
    },
  };
  return stub as unknown as Client;
}

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    ...overrides,
  };
}

async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const event of gen) {
    results.push(event);
  }
  return results;
}

describe('CodeExecutionRequestProcessor', () => {
  describe('early-exit paths', () => {
    it('yields no events and leaves request unchanged for a non-LlmAgent', async () => {
      const agent = new MockBaseAgent('non-llm-agent');
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
      expect(llmRequest.contents).toHaveLength(1);
    });

    it('yields no events when LlmAgent has no codeExecutor', async () => {
      const agent = new LlmAgent({
        name: 'agent-no-executor',
        model: 'gemini-2.5-flash',
      });
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
    });

    it('calls runPreProcessor and proceeds to convertCodeExecutionParts when codeExecutor is BaseCodeExecutor', async () => {
      const executor = new TestCodeExecutor();
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: executor,
      });
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      // Should not throw — runPreProcessor exits early because
      // isBuiltInCodeExecutor is false and optimizeDataFile is false
      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
      // Content should still be present after processing
      expect(llmRequest.contents).toHaveLength(1);
    });
  });
});

describe('CodeExecutionResponseProcessor', () => {
  const responseProcessor = new CodeExecutionResponseProcessor();

  describe('early-exit paths', () => {
    it('yields no events for a partial response', async () => {
      const agent = new LlmAgent({
        name: 'agent',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const partialResponse = {
        partial: true,
        content: {role: 'model', parts: [{text: 'thinking...'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, partialResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events for a non-LlmAgent', async () => {
      const agent = new MockBaseAgent('non-llm');
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'done'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when LlmAgent has no codeExecutor', async () => {
      const agent = new LlmAgent({
        name: 'agent-no-executor',
        model: 'gemini-2.5-flash',
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'done'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when response has no content', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {partial: false};

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when response content has no code block', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'plain text response'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });
  });

  describe('sandbox state delta', () => {
    it('publishes the Agent Engine sandbox name on the code execution result event', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-sandbox-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new AgentEngineSandboxCodeExecutor({
          client: createSandboxClient(),
        }),
      });
      const ctx = createMockInvocationContext(
        agent,
        new ScopedArtifactService(
          new InMemoryArtifactService(),
          'test-app',
          'test-user',
          'test-session',
        ),
      );
      const llmResponse = {
        partial: false,
        content: {
          role: 'model',
          parts: [{text: 'Here you go:\n```python\nprint("hi")\n```'}],
        },
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      const resultEvent = events[events.length - 1];
      expect(resultEvent.actions.stateDelta['_code_execution_context']).toEqual(
        expect.objectContaining({
          sandbox_names: {language_python: SANDBOX_NAME},
        }),
      );
    });
  });
});
