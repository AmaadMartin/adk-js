/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
  StreamingMode,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {ReplayLlm} from '../../src/integration/replay_llm.js';
import {Recording} from '../../src/integration/test_types.js';

const EMPTY_REQUEST: LlmRequest = {
  contents: [],
  liveConnectConfig: {},
  toolsDict: {},
};

function textResponse(text: string, partial?: boolean): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, partial};
}

function llmRecording(
  agentName: string,
  userMessageIndex: number,
  llmResponses?: LlmResponse[],
): Recording {
  return {agentName, userMessageIndex, llmRecording: {llmResponses}};
}

async function collect(llm: ReplayLlm): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(EMPTY_REQUEST)) {
    responses.push(response);
  }
  return responses;
}

function replayLlm(
  recordings: Recording[],
  context = {userMessageIndex: 0},
): ReplayLlm {
  return new ReplayLlm({agentName: 'agent-a', recordings, context});
}

describe('ReplayLlm', () => {
  it('yields every response of one SSE recording, in order', async () => {
    const llm = replayLlm([
      llmRecording('agent-a', 0, [
        textResponse('I ', true),
        textResponse('rolled ', true),
        textResponse('I rolled a 4'),
      ]),
    ]);

    await expect(collect(llm)).resolves.toEqual([
      textResponse('I ', true),
      textResponse('rolled ', true),
      textResponse('I rolled a 4'),
    ]);
  });

  it('consumes the next recording on the next call of the same turn', async () => {
    const llm = replayLlm([
      llmRecording('agent-a', 0, [textResponse('first')]),
      llmRecording('agent-a', 0, [textResponse('second')]),
    ]);

    await expect(collect(llm)).resolves.toEqual([textResponse('first')]);
    await expect(collect(llm)).resolves.toEqual([textResponse('second')]);
  });

  it('ignores recordings of another agent', async () => {
    const llm = replayLlm([
      llmRecording('agent-b', 0, [textResponse('theirs')]),
      llmRecording('agent-a', 0, [textResponse('mine')]),
    ]);

    await expect(collect(llm)).resolves.toEqual([textResponse('mine')]);
  });

  it('ignores recordings of another turn', async () => {
    const llm = replayLlm([
      llmRecording('agent-a', 1, [textResponse('later')]),
      llmRecording('agent-a', 0, [textResponse('now')]),
    ]);

    await expect(collect(llm)).resolves.toEqual([textResponse('now')]);
  });

  it('ignores a recording that holds no LLM pair', async () => {
    const llm = replayLlm([
      {
        agentName: 'agent-a',
        userMessageIndex: 0,
        toolRecording: {toolCall: {name: 'roll_die'}},
      },
      llmRecording('agent-a', 0, [textResponse('mine')]),
    ]);

    await expect(collect(llm)).resolves.toEqual([textResponse('mine')]);
  });

  it('ignores a recording left behind by the pre-rename schema', async () => {
    const llm = replayLlm([
      llmRecording('agent-a', 0, []),
      llmRecording('agent-a', 0, [textResponse('mine')]),
    ]);

    await expect(collect(llm)).resolves.toEqual([textResponse('mine')]);
  });

  it('restarts at the first recording of the next turn', async () => {
    const context = {userMessageIndex: 0};
    const llm = replayLlm(
      [
        llmRecording('agent-a', 0, [textResponse('turn 0')]),
        llmRecording('agent-a', 1, [textResponse('turn 1')]),
      ],
      context,
    );

    await expect(collect(llm)).resolves.toEqual([textResponse('turn 0')]);

    context.userMessageIndex = 1;

    await expect(collect(llm)).resolves.toEqual([textResponse('turn 1')]);
  });

  it('rejects when the runtime asks for more calls than were recorded', async () => {
    const llm = replayLlm([llmRecording('agent-a', 0, [textResponse('only')])]);

    await collect(llm);

    await expect(collect(llm)).rejects.toThrow(
      "Runtime sent more LLM requests than expected for agent 'agent-a' at " +
        'user message index 0. Expected 1, but got request at index 1.',
    );
  });

  it('rejects when nothing was recorded for the turn', async () => {
    const llm = replayLlm([
      llmRecording('agent-a', 1, [textResponse('later')]),
    ]);

    await expect(collect(llm)).rejects.toThrow(
      'Expected 0, but got request at index 0.',
    );
  });

  it('rejects a recording that holds no responses', async () => {
    const llm = replayLlm([llmRecording('agent-a', 0)]);

    await expect(collect(llm)).rejects.toThrow(
      'Expected 0, but got request at index 0.',
    );
  });

  it('rejects a live connection', async () => {
    const llm = replayLlm([]);

    await expect(llm.connect(EMPTY_REQUEST)).rejects.toThrow(
      'ReplayLlm.connect should not be called during replay tests.',
    );
  });
});

describe('ReplayLlm driven by the Runner', () => {
  it('surfaces the recorded partials and persists only the complete response', async () => {
    const agent = new LlmAgent({
      name: 'agent-a',
      model: replayLlm([
        llmRecording('agent-a', 0, [
          textResponse('I ', true),
          textResponse('rolled ', true),
          textResponse('I rolled a 4'),
        ]),
      ]),
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({agent, sessionService, appName: 'replay-test'});
    await sessionService.createSession({
      appName: 'replay-test',
      userId: 'user-1',
      sessionId: 'session-1',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: 'session-1',
      newMessage: {role: 'user', parts: [{text: 'roll a die'}]},
      runConfig: {streamingMode: StreamingMode.SSE},
    })) {
      events.push(event);
    }

    expect(events.map((event) => [event.partial, eventText(event)])).toEqual([
      [true, 'I '],
      [true, 'rolled '],
      [undefined, 'I rolled a 4'],
    ]);

    const session = await sessionService.getSession({
      appName: 'replay-test',
      userId: 'user-1',
      sessionId: 'session-1',
    });
    expect(session?.events.map(eventText)).toEqual([
      'roll a die',
      'I rolled a 4',
    ]);
  });
});

function eventText(event: Event): string | undefined {
  return event.content?.parts?.[0]?.text;
}
