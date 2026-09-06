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
import {
  CodeExecutionInput,
  CodeExecutionResult,
} from '../../../src/code_executors/code_execution_utils.js';

/** Base64 of 'user input'. */
const USER_CSV_DATA = 'dXNlciBpbnB1dA==';

/** Base64 of 'model output'. */
const MODEL_CSV_DATA = 'bW9kZWwgb3V0cHV0';

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

/** A data-file executor that records every code execution it is asked for. */
class RecordingCodeExecutor extends BaseCodeExecutor {
  override optimizeDataFile = true;
  readonly executions: CodeExecutionInput[] = [];

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    this.executions.push(params.codeExecutionInput);
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

function createScopedArtifactService(): SessionArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    'test-app',
    'test-user',
    'test-session',
  );
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

  describe('inline data file extraction', () => {
    function createDataFileAgent(): {
      agent: LlmAgent;
      executor: RecordingCodeExecutor;
    } {
      const executor = new RecordingCodeExecutor();
      return {
        executor,
        agent: new LlmAgent({
          name: 'agent-with-data-executor',
          model: 'gemini-2.5-flash',
          codeExecutor: executor,
        }),
      };
    }

    it('replaces a user inline data part with a text-only part', async () => {
      const {agent} = createDataFileAgent();
      const ctx = createMockInvocationContext(
        agent,
        createScopedArtifactService(),
      );
      const llmRequest = createLlmRequest({
        contents: [
          {
            role: 'model',
            parts: [{inlineData: {data: MODEL_CSV_DATA, mimeType: 'text/csv'}}],
          },
          {
            role: 'user',
            parts: [{inlineData: {data: USER_CSV_DATA, mimeType: 'text/csv'}}],
          },
        ],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      const userPart = llmRequest.contents[1].parts?.[0];
      expect(userPart).toEqual({text: '\nAvailable file: `data_2_1.csv`\n'});
      expect(userPart?.inlineData).toBeUndefined();
      expect(events).toHaveLength(2);
    });

    it('leaves model-role content untouched', async () => {
      const {agent} = createDataFileAgent();
      const ctx = createMockInvocationContext(
        agent,
        createScopedArtifactService(),
      );
      const modelPart = {
        inlineData: {data: MODEL_CSV_DATA, mimeType: 'text/csv'},
      };
      const llmRequest = createLlmRequest({
        contents: [
          {role: 'model', parts: [modelPart]},
          {
            role: 'user',
            parts: [{inlineData: {data: USER_CSV_DATA, mimeType: 'text/csv'}}],
          },
        ],
      });

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(llmRequest.contents[0].parts?.[0]).toBe(modelPart);
      expect(modelPart.inlineData.data).toBe(MODEL_CSV_DATA);
    });

    it('hands the extracted file to the executor', async () => {
      const {agent, executor} = createDataFileAgent();
      const ctx = createMockInvocationContext(
        agent,
        createScopedArtifactService(),
      );
      const llmRequest = createLlmRequest({
        contents: [
          {
            role: 'model',
            parts: [{inlineData: {data: MODEL_CSV_DATA, mimeType: 'text/csv'}}],
          },
          {
            role: 'user',
            parts: [{inlineData: {data: USER_CSV_DATA, mimeType: 'text/csv'}}],
          },
        ],
      });

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(executor.executions).toHaveLength(1);
      expect(executor.executions[0].inputFiles).toEqual([
        {name: 'data_2_1.csv', mimeType: 'text/csv', content: 'user input'},
      ]);
    });

    it('leaves unsupported mime types untouched', async () => {
      const {agent, executor} = createDataFileAgent();
      const ctx = createMockInvocationContext(
        agent,
        createScopedArtifactService(),
      );
      const userPart = {
        inlineData: {data: USER_CSV_DATA, mimeType: 'image/png'},
      };
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [userPart]}],
      });

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(llmRequest.contents[0].parts?.[0]).toBe(userPart);
      expect(userPart).toEqual({
        inlineData: {data: USER_CSV_DATA, mimeType: 'image/png'},
      });
      expect(executor.executions).toHaveLength(0);
    });

    it('skips an inline data part with no data', async () => {
      const {agent, executor} = createDataFileAgent();
      const ctx = createMockInvocationContext(
        agent,
        createScopedArtifactService(),
      );
      const userPart = {inlineData: {mimeType: 'text/csv'}};
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [userPart]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(llmRequest.contents[0].parts?.[0]).toBe(userPart);
      expect(userPart).toEqual({inlineData: {mimeType: 'text/csv'}});
      expect(executor.executions).toHaveLength(0);
      expect(events).toHaveLength(0);
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
});
