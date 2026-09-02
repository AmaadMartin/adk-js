/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  getFunctionResponses,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Blob, Content} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const TEST_APP_ID = 'task_completed_app';
const TEST_USER_ID = 'task_completed_user';
const TEST_SESSION_ID = 'task_completed_session';

/**
 * The delay the live flow waits after `task_completed` before it returns.
 * Kept in step with `TASK_COMPLETION_DELAY_MS` in
 * `core/src/agents/llm_agent.ts`, which is module-private.
 */
const EXPECTED_TASK_COMPLETION_DELAY_MS = 1000;

/** Timer slack, so a slow scheduler does not make the assertion flaky. */
const DELAY_TOLERANCE_MS = 100;

class ScriptedConnection implements BaseLlmConnection {
  readonly contentCalls: Content[] = [];
  closed = false;
  private readonly queue = new AsyncQueue<LlmResponse>();

  constructor(responses: LlmResponse[]) {
    for (const response of responses) {
      this.queue.push(response);
    }
  }

  async sendHistory(_history: Content[]): Promise<void> {}

  async sendContent(content: Content): Promise<void> {
    this.contentCalls.push(content);
  }

  async sendRealtime(_blob: Blob): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

class ScriptedLiveLlm extends BaseLlm {
  connection?: ScriptedConnection;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-live-llm'});
  }

  generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    throw new Error('generateContentAsync is not used by these tests.');
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.connection = new ScriptedConnection(this.responses);
    return this.connection;
  }
}

function functionCallResponse(names: string[]): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: names.map((name, index) => ({
        functionCall: {id: `call_${index}`, name, args: {}},
      })),
    },
  };
}

function buildAgent(model: ScriptedLiveLlm): LlmAgent {
  return new LlmAgent({
    name: 'task_agent',
    model,
    tools: [
      new FunctionTool({
        name: 'task_completed',
        description: 'Signals that the task is complete.',
        execute: async () => 'Task completion signaled.',
      }),
      new FunctionTool({
        name: 'take_note',
        description: 'Records a note.',
        execute: async () => 'noted',
      }),
    ],
  });
}

describe('LlmAgent live task completion', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
  });

  async function runLive(model: ScriptedLiveLlm): Promise<Event[]> {
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: buildAgent(model),
      sessionService,
    });
    const liveRequestQueue = new LiveRequestQueue();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue,
    })) {
      events.push(event);
    }
    liveRequestQueue.close();
    return events;
  }

  it('ends the run when the model calls task_completed', async () => {
    const model = new ScriptedLiveLlm([
      functionCallResponse(['task_completed']),
      functionCallResponse(['take_note']),
    ]);

    const events = await runLive(model);

    const responded = events.flatMap((event) =>
      getFunctionResponses(event).map((response) => response.name),
    );
    expect(responded).toContain('task_completed');
    expect(responded).not.toContain('take_note');
  });

  it('ends the run when task_completed is merged with another response', async () => {
    const model = new ScriptedLiveLlm([
      functionCallResponse(['take_note', 'task_completed']),
      functionCallResponse(['take_note']),
    ]);

    const events = await runLive(model);

    const responded = events.flatMap((event) =>
      getFunctionResponses(event).map((response) => response.name),
    );
    expect(responded).toEqual(['take_note', 'task_completed']);
  });

  it('waits the task completion delay before it returns', async () => {
    const model = new ScriptedLiveLlm([
      functionCallResponse(['task_completed']),
    ]);

    const startedAt = Date.now();
    await runLive(model);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(
      EXPECTED_TASK_COMPLETION_DELAY_MS - DELAY_TOLERANCE_MS,
    );
  });
});
