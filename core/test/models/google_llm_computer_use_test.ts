/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerUseToolset,
  Gemini,
  LlmRequest,
  LlmResponse,
  isComputerUseTool,
} from '@google/adk';
import {
  Environment,
  FinishReason,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  MOCK_PAGE_URL,
  MockComputer,
  createToolContext,
} from '../tools/computer_use/computer_use_test_utils.js';

const WAIT_5_SECONDS = 'wait_5_seconds';

beforeEach(() => {
  vi.restoreAllMocks();
});

function modelAnswer(): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: {role: 'model', parts: [{text: 'done'}]},
      finishReason: FinishReason.STOP,
    },
  ];
  return response;
}

function stubModel(client: GoogleGenAI): void {
  vi.spyOn(client.models, 'generateContent').mockResolvedValue(modelAnswer());
}

/** A request carrying every computer-use tool, as an agent run would build. */
async function computerUseRequest(): Promise<LlmRequest> {
  const toolset = new ComputerUseToolset({computer: new MockComputer()});
  const llmRequest: LlmRequest = {
    contents: [{role: 'user', parts: [{text: 'Open the page'}]}],
    config: {systemInstruction: 'Be helpful.'},
    liveConnectConfig: {},
    toolsDict: {},
  };
  await toolset.processLlmRequest(createToolContext(), llmRequest);
  return llmRequest;
}

async function runTurn(llmRequest: LlmRequest): Promise<void> {
  const llm = new Gemini({apiKey: 'test-api-key'});
  stubModel(llm.apiClient);
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(llmRequest)) {
    responses.push(response);
  }
  expect(responses).toHaveLength(1);
}

describe('Gemini computer-use tool adaptation', () => {
  it('replaces wait with the no-argument wait_5_seconds tool', async () => {
    const llmRequest = await computerUseRequest();

    await runTurn(llmRequest);

    expect(llmRequest.toolsDict['wait']).toBeUndefined();
    const adapted = llmRequest.toolsDict[WAIT_5_SECONDS];
    if (!isComputerUseTool(adapted)) {
      expect.fail('wait_5_seconds is not registered as a computer-use tool');
    }
    expect(adapted.screenSize).toEqual({width: 1920, height: 1080});
    expect(adapted.virtualScreenSize).toEqual({width: 1000, height: 1000});
    expect(adapted.computerUse).toEqual({
      environment: Environment.ENVIRONMENT_BROWSER,
    });
    expect(adapted._getDeclaration().parameters?.properties).toEqual({});
  });

  it('waits five seconds when the model calls the adapted tool', async () => {
    const llmRequest = await computerUseRequest();

    await runTurn(llmRequest);

    const result = await llmRequest.toolsDict[WAIT_5_SECONDS].runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({url: `${MOCK_PAGE_URL}/wait/5`});
  });

  it('clears the system instruction the computer-use surface rejects', async () => {
    const llmRequest = await computerUseRequest();

    await runTurn(llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('registers nothing when no wait tool is present', async () => {
    const llmRequest = await computerUseRequest();
    delete llmRequest.toolsDict['wait'];
    const registeredNames = Object.keys(llmRequest.toolsDict);

    await runTurn(llmRequest);

    expect(Object.keys(llmRequest.toolsDict)).toEqual(registeredNames);
    expect(llmRequest.toolsDict[WAIT_5_SECONDS]).toBeUndefined();
  });

  it('leaves a request without a computer-use tool alone', async () => {
    const llmRequest = await computerUseRequest();
    llmRequest.config = {systemInstruction: 'Be helpful.'};

    await runTurn(llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Be helpful.');
    expect(llmRequest.toolsDict['wait']).toBeDefined();
    expect(llmRequest.toolsDict[WAIT_5_SECONDS]).toBeUndefined();
  });
});
