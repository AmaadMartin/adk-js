/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Executes the samples under `samples/labs/`.
 *
 * The sibling `docs_samples_test.ts` covers `samples/workflows/` through a
 * workflow harness; these samples are plain agents, so they are driven through
 * a real `Runner` instead.
 *
 * One turn is not enough here. `samples/labs/antigravity` demonstrates
 * cross-turn continuity, and its stand-in client only fails on the *second*
 * turn, when the wrapper asks to resume a conversation the stand-in has
 * forgotten. Lint, Prettier and `ts:check:samples` all read the file already; a
 * sample that type-checks and still throws on turn two is what this covers.
 */

import {Event, InMemorySessionService, Runner} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {rootAgent as antigravityRootAgent} from '../../../samples/labs/antigravity/agent.js';

/** Drives `agent` over one session for `turns`, returning each turn's events. */
async function runTurns(
  agent: typeof antigravityRootAgent,
  turns: string[],
): Promise<Event[][]> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'labs_sample',
    userId: 'sample_user',
  });
  const runner = new Runner({appName: 'labs_sample', agent, sessionService});

  const perTurn: Event[][] = [];
  for (const text of turns) {
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'sample_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text}]},
    })) {
      events.push(event);
    }
    perTurn.push(events);
  }
  return perTurn;
}

/** The text each event carries, flattened across turns. */
function texts(events: Event[]): string[] {
  return events.flatMap((event) =>
    (event.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => !!text),
  );
}

describe('samples/labs/antigravity', () => {
  it('answers on the first turn and calls the bridged child', async () => {
    const [first] = await runTurns(antigravityRootAgent, ['list the files']);

    expect(texts(first)).toContain(
      'Reviewed the workspace. You asked: list the files',
    );
    // The ADK child reached the harness as a client tool and was answered.
    const responses = first.flatMap((event) =>
      (event.content?.parts ?? [])
        .map((part) => part.functionResponse)
        .filter((response) => !!response),
    );
    expect(responses.map((response) => response.name)).toEqual([
      'antigravity_reviewer',
    ]);
  });

  it('resumes its conversation on the second turn of one session', async () => {
    // The stand-in has to keep its trajectory, or the wrapper reads the empty
    // history as a silently dropped resume and fails the turn.
    const [, second] = await runTurns(antigravityRootAgent, [
      'list the files',
      'now summarize them',
    ]);

    expect(texts(second)).toContain(
      'Reviewed the workspace. You asked: now summarize them',
    );
  });
});
