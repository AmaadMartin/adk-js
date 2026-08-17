/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseLlm,
  BaseLlmConnection,
  createEventsCompactionConfig,
  Event,
  InMemorySessionService,
  LlmAgent,
  LlmEventSummarizer,
  LlmRequest,
  LlmResponse,
  Runner,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'compaction_round_trip_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';
const SUMMARY_TEXT = 'Summary of the earlier turns.';

/** A model that answers with one canned line and records every request. */
class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(
    model: string,
    private readonly reply: string,
  ) {
    super({model});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield {content: {role: 'model', parts: [{text: this.reply}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('RecordingLlm does not support live mode.');
  }
}

function promptTexts(request: LlmRequest): string[] {
  return request.contents.flatMap((content) =>
    (content.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => text !== undefined),
  );
}

async function runTurn(runner: Runner, text: string): Promise<void> {
  for await (const _event of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    // Drain the stream so the invocation, and the compaction after it, finish.
  }
}

function compactionEvents(session: Session): Event[] {
  return session.events.filter((event) => event.actions?.compaction);
}

describe('Runner compaction round trip', () => {
  it('persists a summary and sends it in place of the compacted turns', async () => {
    const agentLlm = new RecordingLlm('agent-model', 'answer');
    const summarizerLlm = new RecordingLlm('summarizer-model', SUMMARY_TEXT);
    const app = new App({
      name: APP_NAME,
      rootAgent: new LlmAgent({name: 'agent', model: agentLlm}),
      eventsCompactionConfig: createEventsCompactionConfig({
        summarizer: new LlmEventSummarizer({llm: summarizerLlm}),
        compactionInterval: 2,
        overlapSize: 0,
      }),
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    await runTurn(runner, 'first question');
    await runTurn(runner, 'second question');

    const afterCompaction = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    if (!afterCompaction) {
      expect.fail('session was not found after the compacted turns');
    }
    const compactions = compactionEvents(afterCompaction);
    expect(compactions).toHaveLength(1);
    expect(
      compactions[0].actions.compaction?.compactedContent.parts?.[0]?.text,
    ).toBe(SUMMARY_TEXT);
    expect(summarizerLlm.requests).toHaveLength(1);

    // The raw events survive in the session; only the prompt elides them.
    expect(
      afterCompaction.events.some((event) =>
        event.content?.parts?.some((part) => part.text === 'first question'),
      ),
    ).toBe(true);

    await runTurn(runner, 'third question');

    const lastPrompt = promptTexts(
      agentLlm.requests[agentLlm.requests.length - 1],
    );
    expect(lastPrompt).toContain(SUMMARY_TEXT);
    expect(lastPrompt).toContain('third question');
    expect(lastPrompt).not.toContain('first question');
    expect(lastPrompt).not.toContain('second question');
  });

  it('leaves the prompt untouched when the app declares no compaction', async () => {
    const agentLlm = new RecordingLlm('agent-model', 'answer');
    const app = new App({
      name: APP_NAME,
      rootAgent: new LlmAgent({name: 'agent', model: agentLlm}),
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    await runTurn(runner, 'first question');
    await runTurn(runner, 'second question');
    await runTurn(runner, 'third question');

    const lastPrompt = promptTexts(
      agentLlm.requests[agentLlm.requests.length - 1],
    );
    expect(lastPrompt).toContain('first question');
    expect(lastPrompt).toContain('second question');
    expect(lastPrompt).toContain('third question');
  });
});
