/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentEngineClient, AgentEngineEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Exercises a real Agent Engine deployment. Run it against a deployed Python
 * ADK app with:
 *
 * ```
 * GOOGLE_CLOUD_PROJECT=my-project GOOGLE_CLOUD_LOCATION=us-central1 \
 *   AGENT_ENGINE_ID=1234567890 npx vitest run --project e2e \
 *   tests/e2e/agent_engines/agent_engine_client_e2e_test.ts
 * ```
 */
const reasoningEngineId = process.env.AGENT_ENGINE_ID ?? '';
const hasLiveEngine =
  !!reasoningEngineId &&
  !!process.env.GOOGLE_CLOUD_PROJECT &&
  process.env.CI !== 'true';
const USER_ID = 'adk-js-e2e-user';

describe.skipIf(!hasLiveEngine)('E2E Live Agent Engine', () => {
  it('creates a session, streams a turn, then lists and deletes the session', async () => {
    const client = new AgentEngineClient({reasoningEngineId});

    const engine = await client.getEngine();
    expect(engine['name']).toBe(client.name);

    const session = await client.createSession({userId: USER_ID});
    expect(session.id).toBeTruthy();

    const events: AgentEngineEvent[] = [];
    for await (const event of client.streamQuery({
      userId: USER_ID,
      sessionId: session.id,
      message: 'Hello, who are you?',
    })) {
      events.push(event);
    }
    expect(events.some((event) => !!event.author)).toBe(true);

    const fetched = await client.getSession({
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(fetched?.id).toBe(session.id);

    const sessions = await client.listSessions({userId: USER_ID});
    expect(sessions.map((item) => item.id)).toContain(session.id);

    await client.deleteSession({userId: USER_ID, sessionId: session.id});
    expect(
      await client.getSession({userId: USER_ID, sessionId: session.id}),
    ).toBeUndefined();
  }, 120_000);
});
