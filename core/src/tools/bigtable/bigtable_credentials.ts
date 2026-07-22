/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// If we need to pass a GoogleAuth object or scopes:
export interface BigtableCredentialsConfig {
  scopes?: string[];
  keyFilename?: string;
  projectId?: string;
}

export const BIGTABLE_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];


