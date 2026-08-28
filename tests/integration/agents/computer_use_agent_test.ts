/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const SCREEN_SIZE: [number, number] = [1920, 1080];

/** Records every request the agent sends, then replays the mock responses. */
class RecordingGemini extends GeminiWithMockResponses {
  readonly requests: LlmRequest[] = [];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield* super.generateContentAsync(llmRequest, stream, abortSignal);
  }
}

/** An in-memory computer that records what the agent asked it to do. */
class FakeComputer extends BaseComputer {
  readonly clicks: Array<{x: number; y: number}> = [];

  async screenSize(): Promise<[number, number]> {
    return SCREEN_SIZE;
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  async clickAt(params: {x: number; y: number}): Promise<ComputerState> {
    this.clicks.push(params);
    return {
      screenshot: new TextEncoder().encode('png-bytes'),
      url: 'https://example.com/clicked',
    };
  }
  async openWebBrowser(): Promise<ComputerState> {
    return this.currentState();
  }
  async hoverAt(): Promise<ComputerState> {
    return this.currentState();
  }
  async typeTextAt(): Promise<ComputerState> {
    return this.currentState();
  }
  async scrollDocument(): Promise<ComputerState> {
    return this.currentState();
  }
  async scrollAt(): Promise<ComputerState> {
    return this.currentState();
  }
  async wait(): Promise<ComputerState> {
    return this.currentState();
  }
  async goBack(): Promise<ComputerState> {
    return this.currentState();
  }
  async goForward(): Promise<ComputerState> {
    return this.currentState();
  }
  async search(): Promise<ComputerState> {
    return this.currentState();
  }
  async navigate(): Promise<ComputerState> {
    return this.currentState();
  }
  async keyCombination(): Promise<ComputerState> {
    return this.currentState();
  }
  async dragAndDrop(): Promise<ComputerState> {
    return this.currentState();
  }
  async currentState(): Promise<ComputerState> {
    return {url: 'https://example.com/'};
  }
}

describe('Agent driving a computer through ComputerUseToolset', () => {
  it('normalizes the model coordinates and sends the computerUse config', async () => {
    const mockResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'click_at',
                    args: {x: 500, y: 500},
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {parts: [{text: 'I clicked the button.'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const computer = new FakeComputer();
    const model = new RecordingGemini(mockResponses);
    const agent = new LlmAgent({
      name: 'browser_agent',
      model,
      tools: [new ComputerUseToolset({computer})],
    });

    const {run} = await createRunner(agent);
    const texts: string[] = [];
    for await (const event of run('click the button')) {
      for (const part of event.content?.parts ?? []) {
        if (part.text) {
          texts.push(part.text);
        }
      }
    }

    // 500 of 1000 virtual maps to 960 of 1920 and 540 of 1080.
    expect(computer.clicks).toEqual([{x: 960, y: 540}]);
    expect(texts).toContain('I clicked the button.');

    // The toolset attached its config, and declared no function itself.
    expect(model.requests[0].config?.tools).toEqual([
      {computerUse: {environment: 'ENVIRONMENT_BROWSER'}},
    ]);
    expect(Object.keys(model.requests[0].toolsDict)).toHaveLength(14);
  });
});
