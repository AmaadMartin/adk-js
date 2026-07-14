/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {
  ArtifactKey,
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
  constructor(
    private readonly delegate: BaseArtifactService,
    private readonly key: ArtifactKey,
  ) {}

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    return this.delegate.saveArtifact({
      key: this.key,
      ...request,
    });
  }

  async loadArtifact(
    request: SessionLoadArtifactRequest,
  ): Promise<Part | undefined> {
    return this.delegate.loadArtifact({
      key: this.key,
      ...request,
    });
  }

  async listArtifactKeys(): Promise<string[]> {
    return this.delegate.listArtifactKeys({
      key: this.key,
    });
  }

  async deleteArtifact(filename: string): Promise<void> {
    return this.delegate.deleteArtifact({
      key: this.key,
      filename,
    });
  }

  async listVersions(filename: string): Promise<number[]> {
    return this.delegate.listVersions({
      key: this.key,
      filename,
    });
  }

  async listArtifactVersions(filename: string): Promise<ArtifactVersion[]> {
    return this.delegate.listArtifactVersions({
      key: this.key,
      filename,
    });
  }

  async getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.delegate.getArtifactVersion({
      key: this.key,
      ...request,
    });
  }
}
