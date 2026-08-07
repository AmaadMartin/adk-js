/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ClientOptions} from 'google-gax';

import {PubSubCredentialsConfig} from './config.js';

/**
 * Builds the options passed to the Pub/Sub `v1.PublisherClient` and
 * `v1.SubscriberClient` constructors, both of which accept `ClientOptions`
 * from `google-gax`.
 *
 * Omitted fields are left absent so the clients fall back to Application
 * Default Credentials.
 */
export function createClientOptions(
  credentialsConfig?: PubSubCredentialsConfig,
): ClientOptions {
  const {projectId, clientEmail, privateKey} = credentialsConfig ?? {};
  return {
    ...(projectId ? {projectId} : {}),
    ...(clientEmail && privateKey
      ? {credentials: {client_email: clientEmail, private_key: privateKey}}
      : {}),
  };
}
