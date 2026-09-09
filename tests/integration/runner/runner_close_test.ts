/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  BaseToolset,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

/** A plugin that records whether the runner closed it. */
class TeardownProbePlugin extends BasePlugin {
  closed = false;

  constructor() {
    super('teardown_probe');
  }

  override async close(): Promise<void> {
    this.closed = true;
  }
}

/** A toolset that records how often the runner closed it. */
class TeardownProbeToolset extends BaseToolset {
  closeCount = 0;

  constructor() {
    super([]);
  }

  override async getTools(): Promise<BaseTool[]> {
    return [];
  }

  override async close(): Promise<void> {
    this.closeCount++;
  }
}

describe('Runner.close', () => {
  it('releases the plugins and toolsets of a runner that already ran', async () => {
    const responses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {parts: [{text: 'Today is Tuesday'}], role: 'model'},
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const plugin = new TeardownProbePlugin();
    const toolset = new TeardownProbeToolset();
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: new LlmAgent({
        model: new GeminiWithMockResponses(responses),
        name: 'assistant',
        description: 'Answers a question',
        instruction: 'answer what day is today',
        tools: [toolset],
      }),
      sessionService,
      plugins: [plugin],
    });

    for await (const _event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {role: 'user', parts: [{text: 'What day is today?'}]},
    })) {
      // Consume the events.
    }

    // The run closes the toolsets itself, and leaves the plugins to the caller.
    expect(toolset.closeCount).toBe(1);
    expect(plugin.closed).toBe(false);

    await runner.close();

    expect(plugin.closed).toBe(true);
    expect(toolset.closeCount).toBe(2);
  });
});
