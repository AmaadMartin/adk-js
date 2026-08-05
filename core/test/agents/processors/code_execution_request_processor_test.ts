/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  FileArtifactService,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  SessionArtifactService,
  createSession,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
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
  CodeExecutionResult,
  File,
  FileContentEncoding,
} from '../../../src/code_executors/code_execution_utils.js';

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

class OutputFileCodeExecutor extends BaseCodeExecutor {
  constructor(private readonly outputFiles: File[]) {
    super();
  }

  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: 'done', stderr: '', outputFiles: this.outputFiles};
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

  describe('output file artifacts', () => {
    const textFile: File = {
      name: 'out.txt',
      content: 'hello from script',
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    };
    const binaryFile: File = {
      name: 'plot.png',
      content: 'iVBORw0KGgo=',
      contentEncoding: FileContentEncoding.BASE64,
      mimeType: 'image/png',
    };
    const tempRoots: string[] = [];

    afterEach(async () => {
      await Promise.all(
        tempRoots.splice(0).map((root) => fs.rm(root, {recursive: true})),
      );
    });

    async function runExecution(
      outputFiles: File[],
      artifactService: SessionArtifactService,
    ): Promise<Event[]> {
      const agent = new LlmAgent({
        name: 'agent-with-output-files',
        model: 'gemini-2.5-flash',
        codeExecutor: new OutputFileCodeExecutor(outputFiles),
      });
      const ctx = createMockInvocationContext(agent, artifactService);
      const llmResponse: LlmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: '```python\nprint(1)\n```'}]},
      };

      return collectEvents(responseProcessor.runAsync(ctx, llmResponse));
    }

    async function createTempFileArtifactService(): Promise<SessionArtifactService> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-'));
      tempRoots.push(root);

      return new ScopedArtifactService(
        new FileArtifactService(root),
        'test-app',
        'test-user',
        'test-session',
      );
    }

    it('base64-encodes a utf-8 output file', async () => {
      const artifactService = new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'test-session',
      );

      const events = await runExecution([textFile], artifactService);

      const saved = await artifactService.loadArtifact({filename: 'out.txt'});
      const data = saved?.inlineData?.data;
      if (data === undefined) {
        expect.fail('no artifact was saved for out.txt');
      }
      expect(data).toBe('aGVsbG8gZnJvbSBzY3JpcHQ=');
      expect(Buffer.from(data, 'base64').toString('utf-8')).toBe(
        'hello from script',
      );
      expect(saved?.inlineData?.mimeType).toBe('text/plain');
      expect(events[events.length - 1].actions.artifactDelta).toEqual({
        'out.txt': 0,
      });
    });

    it('passes a base64 output file through without encoding it twice', async () => {
      const artifactService = new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'test-session',
      );

      const events = await runExecution([binaryFile], artifactService);

      const saved = await artifactService.loadArtifact({filename: 'plot.png'});
      const data = saved?.inlineData?.data;
      if (data === undefined) {
        expect.fail('no artifact was saved for plot.png');
      }
      expect(data).toBe('iVBORw0KGgo=');
      expect(Buffer.from(data, 'base64')).toHaveLength(8);
      expect(saved?.inlineData?.mimeType).toBe('image/png');
      expect(events[events.length - 1].actions.artifactDelta).toEqual({
        'plot.png': 0,
      });
    });

    it('round-trips a utf-8 output file through FileArtifactService', async () => {
      const artifactService = await createTempFileArtifactService();

      await runExecution([textFile], artifactService);

      const loaded = await artifactService.loadArtifact({filename: 'out.txt'});
      const data = loaded?.inlineData?.data;
      if (data === undefined) {
        expect.fail('no artifact was stored for out.txt');
      }
      expect(Buffer.from(data, 'base64').toString('utf-8')).toBe(
        'hello from script',
      );
    });
  });
});
