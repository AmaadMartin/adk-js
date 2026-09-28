/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Session,
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

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';
const INVOCATION_ID = 'test-invocation';

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

/** A code executor that returns a caller-supplied result. */
class FixedResultCodeExecutor extends BaseCodeExecutor {
  constructor(private readonly result: CodeExecutionResult) {
    super();
  }

  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return this.result;
  }
}

interface MockInvocationContextOptions {
  artifactService?: ScopedArtifactService;
  state?: Record<string, unknown>;
  session?: Session;
}

function createMockInvocationContext(
  agent: BaseAgent,
  options: MockInvocationContextOptions = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    agent,
    session:
      options.session ??
      createSession({
        id: SESSION_ID,
        events: [],
        appName: APP_NAME,
        userId: USER_ID,
        state: options.state,
      }),
    artifactService: options.artifactService,
    pluginManager: new PluginManager([]),
  });
}

function createScopedArtifactService(): ScopedArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    APP_NAME,
    USER_ID,
    SESSION_ID,
  );
}

function stateDeltaOf(event: Event): Record<string, unknown> {
  const stateDelta = event.actions?.stateDelta;
  if (!stateDelta) {
    return expect.fail('event carries no stateDelta');
  }
  return stateDelta;
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

  describe('state delta persistence', () => {
    // The response processor clears `content` on the response it is given, so
    // each test needs its own copy.
    function createPythonResponse() {
      return {
        partial: false,
        content: {
          role: 'model',
          parts: [{text: '```python\nprint("hi")\n```'}],
        },
      };
    }

    function createAgent(result: CodeExecutionResult): LlmAgent {
      return new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new FixedResultCodeExecutor(result),
      });
    }

    async function runResponseProcessor(
      ctx: InvocationContext,
    ): Promise<Event> {
      const events = await collectEvents(
        responseProcessor.runAsync(ctx, createPythonResponse()),
      );
      expect(events.length).toBeGreaterThan(0);
      return events[events.length - 1];
    }

    it('publishes the code execution result on the emitted event', async () => {
      const agent = createAgent({stdout: 'ok', stderr: '', outputFiles: []});
      const ctx = createMockInvocationContext(agent, {
        artifactService: createScopedArtifactService(),
      });

      const stateDelta = stateDeltaOf(await runResponseProcessor(ctx));

      const results = stateDelta['_code_execution_results'] as Record<
        string,
        Array<Record<string, unknown>>
      >;
      expect(results[INVOCATION_ID]).toHaveLength(1);
      expect(results[INVOCATION_ID][0]['resultStdout']).toBe('ok');
      expect(stateDelta['_code_execution_context']).toEqual({});
    });

    it('publishes the error count incremented after the result snapshot', async () => {
      const agent = createAgent({stdout: '', stderr: 'boom', outputFiles: []});
      const ctx = createMockInvocationContext(agent, {
        artifactService: createScopedArtifactService(),
      });

      const stateDelta = stateDeltaOf(await runResponseProcessor(ctx));

      expect(stateDelta['_code_executor_error_counts']).toEqual({
        [INVOCATION_ID]: 1,
      });
    });

    it('publishes the reset error count when the execution succeeds', async () => {
      const agent = createAgent({stdout: 'ok', stderr: '', outputFiles: []});
      const ctx = createMockInvocationContext(agent, {
        artifactService: createScopedArtifactService(),
        state: {_code_executor_error_counts: {[INVOCATION_ID]: 1}},
      });

      const stateDelta = stateDeltaOf(await runResponseProcessor(ctx));

      expect(stateDelta['_code_executor_error_counts']).toEqual({});
    });

    it('publishes the cached input files extracted by the pre-processor', async () => {
      const executor = new FixedResultCodeExecutor({
        stdout: 'explored',
        stderr: '',
        outputFiles: [],
      });
      executor.optimizeDataFile = true;
      const agent = new LlmAgent({
        name: 'agent-with-data-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: executor,
      });
      const ctx = createMockInvocationContext(agent, {
        artifactService: createScopedArtifactService(),
      });
      const csv = Buffer.from('a,b\n1,2').toString('base64');
      const llmRequest = createLlmRequest({
        contents: [
          {
            role: 'user',
            parts: [{inlineData: {data: csv, mimeType: 'text/csv'}}],
          },
        ],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      const stateDelta = stateDeltaOf(events[events.length - 1]);
      const inputFiles = stateDelta['_code_executor_input_files'] as Array<
        Record<string, unknown>
      >;
      expect(inputFiles).toHaveLength(1);
      expect(inputFiles[0]['name']).toBe('data_1_1.csv');
      expect(stateDelta['_code_execution_context']).toEqual({
        processed_input_files: ['data_1_1.csv'],
      });
    });

    it('keeps the artifact delta alongside the state delta', async () => {
      const agent = createAgent({
        stdout: 'ok',
        stderr: '',
        outputFiles: [
          {name: 'out.txt', content: 'aGk=', mimeType: 'text/plain'},
        ],
      });
      const ctx = createMockInvocationContext(agent, {
        artifactService: createScopedArtifactService(),
      });

      const event = await runResponseProcessor(ctx);

      expect(event.actions?.artifactDelta).toEqual({'out.txt': 0});
      expect(stateDeltaOf(event)['_code_execution_results']).toBeDefined();
    });

    it('throws when no artifact service is configured', async () => {
      const agent = createAgent({stdout: 'ok', stderr: '', outputFiles: []});
      const ctx = createMockInvocationContext(agent);

      await expect(
        collectEvents(responseProcessor.runAsync(ctx, createPythonResponse())),
      ).rejects.toThrow('Artifact service is not initialized.');
    });

    it('persists the published keys through InMemorySessionService', async () => {
      const sessionService = new InMemorySessionService();
      const session = await sessionService.createSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      const agent = createAgent({stdout: 'ok', stderr: '', outputFiles: []});
      const ctx = createMockInvocationContext(agent, {
        artifactService: createScopedArtifactService(),
        session,
      });

      const event = await runResponseProcessor(ctx);
      await sessionService.appendEvent({session, event});
      const persisted = await sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      });

      if (!persisted) {
        return expect.fail('session was not persisted');
      }
      const results = persisted.state['_code_execution_results'] as Record<
        string,
        unknown[]
      >;
      expect(results[INVOCATION_ID]).toHaveLength(1);
      expect(persisted.state['_code_execution_context']).toEqual({});
    });
  });
});
