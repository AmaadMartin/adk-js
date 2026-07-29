/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent, PubSubToolset} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'e2e_pubsub_test';
const AGENT_NAME = 'pubsub_e2e_agent';
const TEST_TIMEOUT = 60000;

/**
 * Validates the E2E flow for the Pub/Sub messaging toolset.
 *
 * Requires an active GCP project with the Pub/Sub API enabled, an existing
 * topic and subscription, and sufficient IAM roles (e.g. Pub/Sub Editor).
 * Set `GOOGLE_CLOUD_PROJECT`, `PUBSUB_TOPIC` and `PUBSUB_SUBSCRIPTION` (plus a
 * Gemini API key) to run it; the test is skipped otherwise.
 */
describe('E2E PubSubToolset', () => {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const topicName = process.env.PUBSUB_TOPIC;
  const subscriptionName = process.env.PUBSUB_SUBSCRIPTION;

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!projectId;

  const hasLiveCredentials =
    hasAKey && !!projectId && !!topicName && !!subscriptionName;

  it.skipIf(!hasLiveCredentials)(
    'should publish and then pull back a message through the agent',
    async () => {
      const pubsubToolset = new PubSubToolset({
        credentialsConfig: {projectId},
      });

      try {
        const agent = new LlmAgent({
          name: AGENT_NAME,
          description: 'An event-driven assistant backed by Pub/Sub.',
          instruction: `You are an event-driven assistant.
You have tools to publish to and pull from Pub/Sub.
1. First, publish a message containing "Hello E2E" to the topic provided.
2. Then, pull messages from the subscription provided, auto-acknowledging them.
3. Report the message id from the published message and the content of the
   pulled messages.`,
          model: 'gemini-2.5-flash',
          tools: [pubsubToolset],
        });

        const runner = new InMemoryRunner({agent, appName: APP_NAME});
        const session = await runner.sessionService.createSession({
          appName: APP_NAME,
          userId: 'test_user',
        });

        let finalResponse = '';
        for await (const event of runner.runAsync({
          userId: 'test_user',
          sessionId: session.id,
          newMessage: createUserContent(
            `Topic: ${topicName}\nSubscription: ${subscriptionName}`,
          ),
        })) {
          if (event.author === AGENT_NAME && event.content?.parts?.[0]?.text) {
            finalResponse += event.content.parts[0].text;
          }
        }

        expect(finalResponse).toContain('Hello E2E');
      } finally {
        await pubsubToolset.close();
      }
    },
    TEST_TIMEOUT,
  );

  it('should expose its tools without constructing a Pub/Sub client', async () => {
    // Runs unconditionally: no GCP credentials are needed to build the toolset
    // or read its tool declarations, so this covers the wiring the sample above
    // exercises (agent construction, tool discovery) on every CI run.
    const pubsubToolset = new PubSubToolset();

    try {
      const agent = new LlmAgent({
        name: AGENT_NAME,
        description: 'An event-driven assistant backed by Pub/Sub.',
        model: 'gemini-2.5-flash',
        tools: [pubsubToolset],
      });

      const tools = await agent.canonicalTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        'publish_message',
        'pull_messages',
        'acknowledge_messages',
      ]);
    } finally {
      await pubsubToolset.close();
    }
  });
});
