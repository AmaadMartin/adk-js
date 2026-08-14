/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SessionArtifactService} from '@google/adk';
import {InMemoryArtifactService, ScopedArtifactService} from '@google/adk';

/**
 * Builds the session-scoped in-memory artifact service that an invocation
 * context carries.
 */
export function createSessionArtifactService(): SessionArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    'skill-script-integration-app',
    'skill-script-integration-user',
    'skill-script-integration-session',
  );
}

/**
 * Reads back the decoded text of the latest version of an artifact.
 */
export async function loadArtifactText(
  artifactService: SessionArtifactService,
  filename: string,
): Promise<string | undefined> {
  const artifact = await artifactService.loadArtifact({filename});
  const data = artifact?.inlineData?.data;
  return data === undefined
    ? undefined
    : Buffer.from(data, 'base64').toString('utf-8');
}
