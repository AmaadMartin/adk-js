/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Storage} from '@google-cloud/storage';

import {version} from '../../version.js';
import {GcsCredentialsConfig} from './credentials.js';

/** User agent reported by every Cloud Storage client the tools build. */
const USER_AGENT = `adk-gcs-tool google-adk/${version}`;

/** Supplies the Cloud Storage client a tool should operate through. */
export type GcsClientProvider = (project?: string) => Storage;

/**
 * Builds a Cloud Storage client. Without a credentials config the client is
 * built from Application Default Credentials.
 */
export function createGcsClient(
  credentialsConfig?: GcsCredentialsConfig,
  project?: string,
): Storage {
  return new Storage({
    ...(credentialsConfig
      ? credentialsConfig.toStorageOptions(project)
      : {...(project ? {projectId: project} : {})}),
    userAgent: USER_AGENT,
  });
}
