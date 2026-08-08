/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  InMemoryArtifactService,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LoadArtifactsTool,
  Runner,
  ToolProcessLlmRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'system-instruction-app';
const USER_ID = 'test-user';
const STRUCTURED_DIRECTIVE = 'Always answer in French.';

/** Records the request the agent builds so the test can assert on it. */
class CapturingLlm extends BaseLlm {
  capturedRequest?: LlmRequest;

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.capturedRequest = request;
    yield {content: {role: 'model', parts: [{text: 'Bonjour'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return expect.fail('the agent must not open a live connection');
  }
}

/** A tool that sets a structured (non-string) system instruction. */
class StructuredSystemInstructionTool extends BaseTool {
  constructor() {
    super({
      name: 'structured_system_instruction',
      description: 'Sets a structured system instruction.',
    });
  }

  override async processLlmRequest({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    llmRequest.config ??= {};
    llmRequest.config.systemInstruction = {
      role: 'system',
      parts: [{text: STRUCTURED_DIRECTIVE}],
    };
  }

  async runAsync(): Promise<unknown> {
    return {};
  }
}

describe('LlmAgent system instruction', () => {
  it('keeps a structured instruction that a later tool appends to', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    await artifactService.saveArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      filename: 'report.txt',
      artifact: {text: 'quarterly numbers'},
    });

    const llm = new CapturingLlm({model: 'capturing-llm'});
    const runner = new Runner({
      appName: APP_NAME,
      agent: new LlmAgent({
        name: 'repro_agent',
        model: llm,
        tools: [new StructuredSystemInstructionTool(), new LoadArtifactsTool()],
      }),
      sessionService,
      artifactService,
    });

    for await (const _ of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hi'}]},
    })) {
      // Drain the run so that the request is fully built.
    }

    const systemInstruction = llm.capturedRequest?.config?.systemInstruction;
    expect(systemInstruction).toContain(STRUCTURED_DIRECTIVE);
    expect(systemInstruction).toContain('You have a list of artifacts');
    expect(systemInstruction).not.toContain('[object Object]');
  });
});
