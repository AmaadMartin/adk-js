/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  SessionArtifactService,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  CodeExecutionResponseProcessor,
} from '../../../src/agents/processors/code_execution_request_processor.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../../src/code_executors/base_code_executor.js';
import {CodeExecutionResult} from '../../../src/code_executors/code_execution_utils.js';

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

class FixedResultCodeExecutor extends BaseCodeExecutor {
  constructor(private readonly result: CodeExecutionResult) {
    super();
  }

  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return this.result;
  }
}

function createMockInvocationContext(
  agent: BaseAgent,
  artifactService?: SessionArtifactService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    artifactService,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
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

  describe('artifact service requirement for the execution result', () => {
    const pythonCodeResponse = {
      partial: false,
      content: {
        role: 'model',
        parts: [{text: '```python\nprint("hello")\n```'}],
      },
    };
    const outputFile = {
      name: 'plot.png',
      content: 'YWJj',
      mimeType: 'image/png',
    };

    function createAgent(result: CodeExecutionResult): LlmAgent {
      return new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new FixedResultCodeExecutor(result),
      });
    }

    it('emits the result event without an artifact service when there are no output files', async () => {
      const agent = createAgent({
        stdout: 'hello',
        stderr: '',
        outputFiles: [],
      });
      const ctx = createMockInvocationContext(agent);

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, {...pythonCodeResponse}),
      );

      expect(events).toHaveLength(2);
      expect(events[1].actions.artifactDelta).toEqual({});
    });

    it('records the error count for a failed execution without an artifact service', async () => {
      const agent = createAgent({
        stdout: '',
        stderr: 'boom',
        outputFiles: [],
      });
      const ctx = createMockInvocationContext(agent);

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, {...pythonCodeResponse}),
      );

      expect(events).toHaveLength(2);
      expect(ctx.session.state['_code_executor_error_counts']).toEqual({
        'test-invocation': 1,
      });
    });

    it('throws without an artifact service when there are output files', async () => {
      const agent = createAgent({
        stdout: '',
        stderr: '',
        outputFiles: [outputFile],
      });
      const ctx = createMockInvocationContext(agent);

      await expect(
        collectEvents(responseProcessor.runAsync(ctx, {...pythonCodeResponse})),
      ).rejects.toThrow('Artifact service is not initialized.');
    });

    it('saves output files and records the artifact delta when an artifact service is configured', async () => {
      const agent = createAgent({
        stdout: '',
        stderr: '',
        outputFiles: [outputFile],
      });
      const artifactService = new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'test-session',
      );
      const ctx = createMockInvocationContext(agent, artifactService);

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, {...pythonCodeResponse}),
      );

      expect(events).toHaveLength(2);
      expect(events[1].actions.artifactDelta).toEqual({'plot.png': 0});
      await expect(
        artifactService.loadArtifact({filename: 'plot.png'}),
      ).resolves.toEqual({
        inlineData: {data: outputFile.content, mimeType: outputFile.mimeType},
      });
    });
  });
});
