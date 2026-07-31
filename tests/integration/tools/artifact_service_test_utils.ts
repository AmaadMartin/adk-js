/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ArtifactVersion,
  InMemoryArtifactService,
  SessionArtifactService,
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
} from '@google/adk';
import {Part} from '@google/genai';

const APP_NAME = 'skill-script-integration-app';
const USER_ID = 'skill-script-integration-user';
const SESSION_ID = 'skill-script-integration-session';

/**
 * Binds an {@link InMemoryArtifactService} to a single session so it can be
 * used as the `artifactService` of an invocation context. The framework does
 * this with its own internal wrapper; tests reach the same surface through the
 * public {@link SessionArtifactService} interface.
 */
export class SessionScopedInMemoryArtifactService implements SessionArtifactService {
  private readonly delegate = new InMemoryArtifactService();
  private readonly scope = {
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  };

  saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    return this.delegate.saveArtifact({...this.scope, ...request});
  }

  loadArtifact(request: SessionLoadArtifactRequest): Promise<Part | undefined> {
    return this.delegate.loadArtifact({...this.scope, ...request});
  }

  listArtifactKeys(): Promise<string[]> {
    return this.delegate.listArtifactKeys(this.scope);
  }

  deleteArtifact(filename: string): Promise<void> {
    return this.delegate.deleteArtifact({...this.scope, filename});
  }

  listVersions(filename: string): Promise<number[]> {
    return this.delegate.listVersions({...this.scope, filename});
  }

  listArtifactVersions(filename: string): Promise<ArtifactVersion[]> {
    return this.delegate.listArtifactVersions({...this.scope, filename});
  }

  getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.delegate.getArtifactVersion({...this.scope, ...request});
  }
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
