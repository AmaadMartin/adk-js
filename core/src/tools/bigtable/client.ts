/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bigtable} from '@google-cloud/bigtable';
import {GoogleAuth} from 'google-auth-library';
import {version} from '../../version.js';
import {BigtableCredentialsConfig, BIGTABLE_DEFAULT_SCOPE} from './bigtable_credentials.js';

const USER_AGENT = `adk-bigtable-tool google-adk/${version}`;

const clientCache = new Map<string, Bigtable>();

export function getBigtableClient(
  projectId: string,
  config?: BigtableCredentialsConfig
): Bigtable {
  if (clientCache.has(projectId)) {
    return clientCache.get(projectId)!;
  }

  const scopes = config?.scopes || BIGTABLE_DEFAULT_SCOPE;
  const auth = new GoogleAuth({
    scopes,
    keyFilename: config?.keyFilename,
    projectId: config?.projectId || projectId,
  });

  const client = new Bigtable({
    projectId,
    authClient: auth as any, // Sometimes type conflict with GoogleAuth
    apiEndpoint: 'bigtable.googleapis.com'
  });
  
  clientCache.set(projectId, client);
  return client;
}
