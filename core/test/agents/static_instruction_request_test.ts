/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {
  BaseLlm,
  createEvent,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Runner,
} from '@google/adk';
import type {Content} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  INSTRUCTION_BEGIN,
  INSTRUCTION_END,
} from '../../src/agents/instructions.js';

const STATIC_TEXT = 'You are a document analyst.';
const MANUAL_URI = 'gs://bucket/manual.pdf';

/** Records the request the agent's processor chain assembles. */
class CapturingLlm extends BaseLlm {
  capturedRequest?: LlmRequest;

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.capturedRequest = request;
    yield {content: {role: 'model', parts: [{text: 'Done.'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

describe('an agent with a static instruction and a dynamic one', () => {
  let request: LlmRequest;

  beforeEach(async () => {
    const llm = new CapturingLlm({model: 'gemini-2.5-flash'});
    const agent = new LlmAgent({
      name: 'doc_agent',
      model: llm,
      staticInstruction: [
        STATIC_TEXT,
        {fileData: {fileUri: MANUAL_URI, mimeType: 'application/pdf'}},
      ],
      instruction: 'The user is {user_name}. Answer from the manual only.',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_static',
      session: createSession({
        id: 'sess_static',
        appName: 'test-app',
        userId: 'test-user',
        state: {user_name: 'Alice'},
        events: [
          createEvent({
            invocationId: 'inv_earlier',
            author: 'user',
            content: {role: 'user', parts: [{text: 'What does it say?'}]},
          }),
        ],
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    if (!llm.capturedRequest) {
      expect.fail('the agent never called the model');
    }
    request = llm.capturedRequest;
  });

  it('puts the static text and the file reference in the system instruction', () => {
    expect(request.config?.systemInstruction).toContain(
      `${STATIC_TEXT}\n\n[Reference to file data: file_data_0 ` +
        `(URI: ${MANUAL_URI}, type: application/pdf)]`,
    );
  });

  it('keeps the dynamic instruction out of the system instruction', () => {
    expect(request.config?.systemInstruction).not.toContain('The user is');
  });

  it('orders the static file, the labelled instruction, then the history', () => {
    expect(request.contents).toHaveLength(3);
    expect(request.contents[0].parts?.[1].fileData?.fileUri).toBe(MANUAL_URI);

    const labelled = request.contents[1].parts?.[0].text ?? '';
    expect(labelled).toContain(INSTRUCTION_BEGIN);
    expect(labelled).toContain(INSTRUCTION_END);
    expect(labelled).toContain('The user is Alice.');

    expect(request.contents[2].parts?.[0].text).toBe('What does it say?');
  });
});

const HANDBOOK = {
  fileUri: 'files/handbook',
  mimeType: 'application/pdf',
  displayName: 'handbook.pdf',
};

/** Records the request the whole processor chain produced. */
class RecordingLlm extends BaseLlm {
  request?: LlmRequest;

  constructor() {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.request = request;
    yield {content: {role: 'model', parts: [{text: 'Done.'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

/** Returns the request a full agent run sends to the model. */
async function runAgentAndCaptureRequest(): Promise<LlmRequest> {
  const model = new RecordingLlm();
  const agent = new LlmAgent({
    name: 'support_agent',
    model,
    staticInstruction: {
      role: 'user',
      parts: [
        {text: 'Answer only from the handbook below.'},
        {
          fileData: HANDBOOK,
        },
      ],
    },
    instruction: 'The current user is {user_name}.',
  });

  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'test_user',
    state: {user_name: 'Ada'},
  });
  const runner = new Runner({appName: 'test_app', agent, sessionService});

  for await (const _event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'What is the refund window?'}]},
  })) {
    // The request is captured by the model; the events are not asserted here.
  }

  expect(model.request).toBeDefined();
  return model.request!;
}

function textOf(content: Content): string {
  return content.parts?.[0]?.text ?? '';
}

describe('a request carrying a static instruction', () => {
  it('references the file data from the system instruction', async () => {
    const request = await runAgentAndCaptureRequest();

    // The identity processor runs first, so the static text follows its
    // preamble rather than starting the system instruction.
    expect(request.config?.systemInstruction).toContain(
      'Answer only from the handbook below.\n\n[Reference to file data: ' +
        "file_data_0 ('handbook.pdf', URI: files/handbook, " +
        'type: application/pdf)]',
    );
    expect(request.config?.systemInstruction).not.toContain(
      'The current user is',
    );
  });

  it('leads the contents with the referenced file data', async () => {
    const request = await runAgentAndCaptureRequest();

    expect(request.contents[0]).toEqual({
      role: 'user',
      parts: [
        {text: 'Referenced file data: file_data_0'},
        {fileData: HANDBOOK},
      ],
    });
  });

  it('puts the labelled dynamic instruction before the real user turn', async () => {
    const request = await runAgentAndCaptureRequest();

    const texts = request.contents.map(textOf);
    const instructionIndex = texts.findIndex((text) =>
      text.includes(INSTRUCTION_BEGIN),
    );
    const userIndex = texts.indexOf('What is the refund window?');

    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(instructionIndex);
    expect(texts[instructionIndex]).toContain('The current user is Ada.');
    expect(texts[instructionIndex].endsWith(INSTRUCTION_END)).toBe(true);
  });

  it('leaves the real user turn free of markers', async () => {
    const request = await runAgentAndCaptureRequest();

    const userTurn = request.contents.find(
      (content) => textOf(content) === 'What is the refund window?',
    );

    expect(userTurn).toBeDefined();
    expect(textOf(userTurn!)).not.toContain(INSTRUCTION_BEGIN);
    expect(textOf(userTurn!)).not.toContain(INSTRUCTION_END);
  });
});
