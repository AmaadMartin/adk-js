/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Gated, manual end-to-end harness for {@link AgentEngineClient}. It exercises
 * the real transport (no mocks) against a deployed Vertex AI Agent Engine, so it
 * is a no-op in CI and only runs when `AGENT_ENGINE_ID` is set.
 *
 * Run against live infrastructure with Application Default Credentials
 * (`gcloud auth application-default login`) configured:
 *
 * ```sh
 * GOOGLE_CLOUD_PROJECT=<proj> \
 * GOOGLE_CLOUD_LOCATION=<loc> \
 * AGENT_ENGINE_ID=<id> \
 *   npx vitest run core/test/agents/agent_engine_client_e2e_test.ts
 * ```
 */

import {AgentEngineClient, type Event} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AGENT_ENGINE_ID = process.env['AGENT_ENGINE_ID'];
const PROJECT = process.env['GOOGLE_CLOUD_PROJECT'];
const LOCATION = process.env['GOOGLE_CLOUD_LOCATION'] ?? 'us-central1';
const USER_ID = 'adk-js-e2e-user';

describe('AgentEngineClient (live E2E)', () => {
  it.skipIf(!AGENT_ENGINE_ID)(
    'creates a session and streams events from a deployed engine',
    async () => {
      expect(PROJECT, 'GOOGLE_CLOUD_PROJECT must be set').toBeTruthy();

      const engine = AgentEngineClient.get(
        `projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${AGENT_ENGINE_ID}`,
      );

      const session = await engine.createSession({userId: USER_ID});
      expect(session.id).toBeTruthy();

      const events: Event[] = [];
      for await (const event of engine.streamQuery({
        userId: USER_ID,
        sessionId: session.id,
        message: 'Hello from the adk-js end-to-end test.',
      })) {
        console.log('event:', event.author, JSON.stringify(event.content));
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it.skipIf(!AGENT_ENGINE_ID)(
    'round-trips a session through get, list, and delete',
    async () => {
      expect(PROJECT, 'GOOGLE_CLOUD_PROJECT must be set').toBeTruthy();

      const engine = AgentEngineClient.get(
        `projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${AGENT_ENGINE_ID}`,
      );

      const created = await engine.createSession({userId: USER_ID});
      expect(created.id).toBeTruthy();

      const fetched = await engine.getSession({
        userId: USER_ID,
        sessionId: created.id,
      });
      expect(fetched?.id).toBe(created.id);

      const sessions = await engine.listSessions({userId: USER_ID});
      expect(sessions.some((session) => session.id === created.id)).toBe(true);

      await engine.deleteSession({userId: USER_ID, sessionId: created.id});

      const afterDelete = await engine.getSession({
        userId: USER_ID,
        sessionId: created.id,
      });
      expect(afterDelete).toBeUndefined();
    },
    60_000,
  );
});
