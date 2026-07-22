/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {v1} from '@google-cloud/pubsub';
import {PubSubCredentialsConfig} from './config.js';

let sharedPublisherClient: v1.PublisherClient | null = null;
let sharedSubscriberClient: v1.SubscriberClient | null = null;

function createClientOptions(credentialsConfig?: PubSubCredentialsConfig): any {
  const options: any = {};
  if (credentialsConfig?.projectId) {
    options.projectId = credentialsConfig.projectId;
  }
  if (credentialsConfig?.clientEmail && credentialsConfig?.privateKey) {
    options.credentials = {
      client_email: credentialsConfig.clientEmail,
      private_key: credentialsConfig.privateKey,
    };
  }
  return options;
}

/**
 * Returns a shared instance of the PublisherClient.
 *
 * @param credentialsConfig Optional credentials configuration.
 * @return A PublisherClient instance.
 */
export function getPublisherClient(
  credentialsConfig?: PubSubCredentialsConfig,
): v1.PublisherClient {
  if (!sharedPublisherClient) {
    sharedPublisherClient = new v1.PublisherClient(
      createClientOptions(credentialsConfig),
    );
  }
  return sharedPublisherClient;
}

/**
 * Returns a shared instance of the SubscriberClient.
 *
 * @param credentialsConfig Optional credentials configuration.
 * @return A SubscriberClient instance.
 */
export function getSubscriberClient(
  credentialsConfig?: PubSubCredentialsConfig,
): v1.SubscriberClient {
  if (!sharedSubscriberClient) {
    sharedSubscriberClient = new v1.SubscriberClient(
      createClientOptions(credentialsConfig),
    );
  }
  return sharedSubscriberClient;
}

/**
 * Cleans up shared Pub/Sub clients if they exist.
 */
export async function cleanupClients(): Promise<void> {
  const closures: Array<Promise<void>> = [];
  if (sharedPublisherClient) {
    closures.push(sharedPublisherClient.close());
    sharedPublisherClient = null;
  }
  if (sharedSubscriberClient) {
    closures.push(sharedSubscriberClient.close());
    sharedSubscriberClient = null;
  }
  await Promise.all(closures);
}
