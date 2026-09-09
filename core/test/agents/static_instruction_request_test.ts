/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
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
