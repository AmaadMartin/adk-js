/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Agent} from '../src/index.js'; // public API export
import {PubSubToolset} from '../src/tools/pubsub/index.js';

/**
 * Validates the E2E flow for the Pub/Sub messaging toolset.
 * Note: You must have an active GCP project with Pub/Sub API enabled,
 * and sufficient IAM roles (e.g., Pub/Sub Editor) to publish/pull.
 * 
 * Set GCP_PROJECT_ID, PUBSUB_TOPIC, PUBSUB_SUBSCRIPTION in your environment.
 */
async function runE2e() {
  const projectId = process.env.GCP_PROJECT_ID;
  const topicName = process.env.PUBSUB_TOPIC;
  const subscriptionName = process.env.PUBSUB_SUBSCRIPTION;

  if (!projectId || !topicName || !subscriptionName) {
    console.warn('Skipping E2E PubSub test. Missing env vars: GCP_PROJECT_ID, PUBSUB_TOPIC, PUBSUB_SUBSCRIPTION.');
    return;
  }

  const pubsubToolset = new PubSubToolset({
    pubsubToolConfig: {projectId},
  });

  const agent = new Agent({
    name: 'PubSub E2E Agent',
    instruction: `You are an event-driven assistant. 
    You have tools to publish to and pull from Pub/Sub.
    1. First, publish a message containing "Hello E2E" to the topic provided.
    2. Then, pull messages from the subscription provided, auto-acknowledging the messages.
    3. Return the exact message id from the published message and the content of the pulled messages to the user.`,
    model: 'gemini-3.1-pro',
    toolsets: [pubsubToolset],
  });

  console.log('Sending message to Agent...');
  const result = await agent.sendMessage({
    content: `Topic: ${topicName}\nSubscription: ${subscriptionName}`,
  });

  console.log('Agent Response:');
  console.log(result.text);
  
  await pubsubToolset.close();
  console.log('E2E PubSub test finished successfully.');
}

runE2e().catch(console.error);
