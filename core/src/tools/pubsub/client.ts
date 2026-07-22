/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PubSubCredentialsConfig} from './config.js';
export function createClientOptions(
  credentialsConfig?: PubSubCredentialsConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
