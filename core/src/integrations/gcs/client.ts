/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Storage} from '@google-cloud/storage';

import {version} from '../../version.js';
import {GCSCredentialsConfig} from './gcs_credentials.js';

/** User agent reported by every Cloud Storage client the tools build. */
export const USER_AGENT = `adk-gcs-tool google-adk/${version}`;

/** Supplies the Cloud Storage client a tool should operate through. */
export type GcsClientProvider = (project?: string) => Storage;

/**
 * Cap on memoised clients per credentials config. Project ids reach
 * {@link getGcsClient} from model-supplied tool arguments, so the cache is
 * bounded and dropped wholesale once it overflows.
 */
const MAX_CACHED_CLIENTS_PER_CONFIG = 16;

/** Cache key standing in for "no credentials config" (the ADC path). */
const DEFAULT_CREDENTIALS_KEY = {};

const clientCache = new WeakMap<object, Map<string, Storage>>();

/**
 * Returns a Cloud Storage client, memoised per credentials config and
 * project so repeated tool calls reuse one authenticated client.
 *
 * Without a credentials config the client is built from Application Default
 * Credentials.
 */
export function getGcsClient(
  credentialsConfig?: GCSCredentialsConfig,
  project?: string,
): Storage {
  const cacheKey = credentialsConfig ?? DEFAULT_CREDENTIALS_KEY;
  let clients = clientCache.get(cacheKey);
  if (!clients) {
    clients = new Map<string, Storage>();
    clientCache.set(cacheKey, clients);
  }

  const projectKey = project ?? '';
  const cached = clients.get(projectKey);
  if (cached) {
    return cached;
  }

  const client = new Storage({
    ...(credentialsConfig
      ? credentialsConfig.toStorageOptions(project)
      : {...(project ? {projectId: project} : {})}),
    userAgent: USER_AGENT,
  });
  if (clients.size >= MAX_CACHED_CLIENTS_PER_CONFIG) {
    clients.clear();
  }
  clients.set(projectKey, client);
  return client;
}
