/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Event,
  LlmRequest,
  LlmResponse,
  ProcessPlanningResponseParams,
} from '@google/adk';
import {BasePlanner, LlmAgent, stringifyContent} from '@google/adk';
import type {Content, Part} from '@google/genai';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const PLANNING_INSTRUCTION = 'Plan the steps before you answer.';
const THOUGHT_MARKER = '[PLAN]';

/** A snapshot of one model call, taken before the request can be mutated. */
interface RecordedRequest {
  systemInstruction: string | undefined;
  contents: Content[];
}

/**
 * A mocked Gemini that snapshots each request the flow hands it, so a test can
 * assert what the default processor pipeline actually sent.
 */
class RecordingGemini extends GeminiWithMockResponses {
  readonly requests: RecordedRequest[] = [];

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

/** Marks any part carrying the plan marker as a thought. */
class MarkerPlanner extends BasePlanner {
  buildPlanningInstruction(): string | undefined {
    return PLANNING_INSTRUCTION;
  }

  processPlanningResponse({
    responseParts,
  }: ProcessPlanningResponseParams): Part[] | undefined {
    for (const part of responseParts) {
      if (part.text?.includes(THOUGHT_MARKER)) {
        part.thought = true;
      }
    }
    return responseParts;
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

describe('LlmAgent with a planner', () => {
  it('delivers the planning instruction and strips prior thought markers', async () => {
    const model = new RecordingGemini([
      modelTurn(`${THOUGHT_MARKER} check the store`, 'The store is open.'),
      modelTurn('It closes at six.'),
    ]);
    const agent = new LlmAgent({
      model,
      name: 'planning_agent',
      instruction: 'Answer store questions.',
      planner: new MarkerPlanner(),
    });
    const {run} = await createRunner(agent);

    const firstTurn = await collect(run('Is the store open?'));

    expect(model.requests[0].systemInstruction).toContain(PLANNING_INSTRUCTION);
    const planEvent = firstTurn.find((event) =>
      event.content?.parts?.some((part) => part.thought === true),
    );
    expect(planEvent).toBeDefined();
    if (!planEvent) {
      expect.fail('no event carried a thought part');
    }
    expect(planEvent.content?.parts?.[0].text).toContain(THOUGHT_MARKER);
    expect(planEvent.content?.parts?.[1].thought).toBeUndefined();
    expect(stringifyContent(planEvent)).toBe('The store is open.');

    await collect(run('When does it close?'));

    const secondTurnParts = model.requests[1].contents.flatMap(
      (content) => content.parts ?? [],
    );
    expect(secondTurnParts.length).toBeGreaterThan(1);
    expect(secondTurnParts.every((part) => part.thought === undefined)).toBe(
      true,
    );
  });

  it('leaves the request and the response alone without a planner', async () => {
    const model = new RecordingGemini([
      modelTurn(`${THOUGHT_MARKER} check the store`, 'The store is open.'),
    ]);
    const agent = new LlmAgent({
      model,
      name: 'plain_agent',
      instruction: 'Answer store questions.',
    });
    const {run} = await createRunner(agent);

    const events = await collect(run('Is the store open?'));

    expect(model.requests[0].systemInstruction).not.toContain(
      PLANNING_INSTRUCTION,
    );
    const modelEvent = events.find((event) => event.author === 'plain_agent');
    expect(modelEvent?.content?.parts?.[0].thought).toBeUndefined();
  });
});
