/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, LlmRequest, LlmResponse} from '@google/adk';
import {
  ACTION_TAG,
  FINAL_ANSWER_TAG,
  LlmAgent,
  PLANNING_TAG,
  PlanReActPlanner,
  REASONING_TAG,
  stringifyContent,
} from '@google/adk';
import type {Content} from '@google/genai';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

/** A mocked Gemini that snapshots the request the default pipeline sends. */
class RecordingGemini extends GeminiWithMockResponses {
  readonly requests: Array<{
    systemInstruction: string | undefined;
    contents: Content[];
  }> = [];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const systemInstruction = llmRequest.config?.systemInstruction;
    this.requests.push({
      systemInstruction:
        typeof systemInstruction === 'string' ? systemInstruction : undefined,
      contents: structuredClone(llmRequest.contents),
    });
    yield* super.generateContentAsync(llmRequest, stream, abortSignal);
  }
}

function modelTurn(...texts: string[]): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: texts.map((text) => ({text})), role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

async function collect(
  events: AsyncGenerator<Event, void, undefined>,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

const AGENT_NAME = 'planning_agent';

function requireAgentEvent(events: Event[]): Event {
  const event = events.find((candidate) => candidate.author === AGENT_NAME);
  if (!event) {
    expect.fail(`no event came from ${AGENT_NAME}`);
  }
  return event;
}

function createPlanningAgent(model: RecordingGemini): LlmAgent {
  return new LlmAgent({
    model,
    name: AGENT_NAME,
    instruction: 'Answer store questions.',
    planner: new PlanReActPlanner(),
  });
}

const TAGGED_REPLY =
  `${PLANNING_TAG}1. Check the store hours.\n` +
  `${REASONING_TAG}The hours are on file.\n` +
  `${FINAL_ANSWER_TAG}The store is open.`;

describe('LlmAgent with a PlanReActPlanner', () => {
  it('sends the planning instruction and splits the tagged reply', async () => {
    const model = new RecordingGemini([modelTurn(TAGGED_REPLY)]);
    const {run} = await createRunner(createPlanningAgent(model));

    const events = await collect(run('Is the store open?'));

    expect(model.requests[0].systemInstruction).toContain(
      'The planning part should be under',
    );
    const parts = events.flatMap((event) => event.content?.parts ?? []);
    const thoughtParts = parts.filter((part) => part.thought === true);
    expect(thoughtParts).toHaveLength(1);
    expect(thoughtParts[0].text).toBe(
      '1. Check the store hours.\nThe hours are on file.\n',
    );
    expect(stringifyContent(requireAgentEvent(events))).toBe(
      'The store is open.',
    );
    for (const part of parts) {
      expect(part.text).not.toContain('/*');
    }
  });

  it('clears the thought markers it set before the next turn', async () => {
    const model = new RecordingGemini([
      modelTurn(TAGGED_REPLY),
      modelTurn(`${ACTION_TAG}done`),
    ]);
    const {run} = await createRunner(createPlanningAgent(model));
    const firstTurn = await collect(run('Is the store open?'));
    const firstTurnParts = firstTurn.flatMap(
      (event) => event.content?.parts ?? [],
    );
    expect(firstTurnParts.some((part) => part.thought === true)).toBe(true);

    await collect(run('When does it close?'));

    const secondTurnParts = model.requests[1].contents.flatMap(
      (content) => content.parts ?? [],
    );
    expect(secondTurnParts.length).toBeGreaterThan(1);
    expect(secondTurnParts.every((part) => part.thought === undefined)).toBe(
      true,
    );
  });

  it('passes an untagged reply through unchanged', async () => {
    const model = new RecordingGemini([modelTurn('The store is open.')]);
    const {run} = await createRunner(createPlanningAgent(model));

    const events = await collect(run('Is the store open?'));

    const modelEvent = requireAgentEvent(events);
    expect(stringifyContent(modelEvent)).toBe('The store is open.');
    expect(modelEvent.content?.parts?.[0].thought).toBeUndefined();
  });
});
