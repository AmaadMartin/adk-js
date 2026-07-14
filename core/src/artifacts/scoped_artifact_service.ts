/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {
  ArtifactScope,
  ArtifactVersion,
  BaseArtifactService,
} from './base_artifact_service.js';
import {
  SessionArtifactService,
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
} from './session_artifact_service.js';

/**
 * A wrapper that scopes a BaseArtifactService to a specific session.
 */
export class ScopedArtifactService implements SessionArtifactService {
  private readonly scope: ArtifactScope;

  constructor(delegate: BaseArtifactService, scope: ArtifactScope);
  constructor(
    delegate: BaseArtifactService,
    appName: string,
    userId: string,
    sessionId: string,
  );
  constructor(
    private readonly delegate: BaseArtifactService,
    scopeOrAppName: ArtifactScope | string,
    userId?: string,
    sessionId?: string,
  ) {
    if (typeof scopeOrAppName === 'string') {
      if (!userId || !sessionId) {
        throw new Error(
          'userId and sessionId must be provided when appName is a string.',
        );
      }
      this.scope = {appName: scopeOrAppName, userId, sessionId};
    } else {
      this.scope = scopeOrAppName;
    }
  }

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    return this.delegate.saveArtifact({
      ...this.scope,
      ...request,
    });
  }

  async loadArtifact(
    request: SessionLoadArtifactRequest,
  ): Promise<Part | undefined> {
    return this.delegate.loadArtifact({
      ...this.scope,
      ...request,
    });
  }

  async listArtifactKeys(): Promise<string[]> {
    return this.delegate.listArtifactKeys({
      ...this.scope,
    });
  }

  async deleteArtifact(filename: string): Promise<void> {
    return this.delegate.deleteArtifact({
      ...this.scope,
      filename,
    });
  }

  async listVersions(filename: string): Promise<number[]> {
    return this.delegate.listVersions({
      ...this.scope,
      filename,
    });
  }

  async listArtifactVersions(filename: string): Promise<ArtifactVersion[]> {
    return this.delegate.listArtifactVersions({
      ...this.scope,
      filename,
    });
  }

  async getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.delegate.getArtifactVersion({
      ...this.scope,
      ...request,
    });
  }
}
