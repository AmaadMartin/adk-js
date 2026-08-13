/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';

import type {InvocationContext} from '../agents/invocation_context.js';
import type {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from '../artifacts/base_artifact_service.js';
import type {SessionArtifactService} from '../artifacts/session_artifact_service.js';

import type {Context} from '../agents/context.js';

/**
 * Artifact service that forwards to the parent tool context.
 */
export class ForwardingArtifactService implements BaseArtifactService {
  private readonly invocationContext: InvocationContext;

  constructor(private readonly toolContext: Context) {
    this.invocationContext = toolContext.invocationContext;
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    return this.toolContext.saveArtifact(request.filename, request.artifact);
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    return this.toolContext.loadArtifact(request.filename, request.version);
  }

  async listArtifactKeys(_request: ListArtifactKeysRequest): Promise<string[]> {
    return this.toolContext.listArtifacts();
  }

  private getArtifactService(): SessionArtifactService {
    const service = this.invocationContext.artifactService;
    if (!service) {
      throw new Error('Artifact service is not initialized.');
    }
    return service;
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    return this.getArtifactService().deleteArtifact(request.filename);
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    return this.getArtifactService().listVersions(request.filename);
  }

  async listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    return this.getArtifactService().listArtifactVersions(request.filename);
  }

  async getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    return this.getArtifactService().getArtifactVersion({
      filename: request.filename,
      version: request.version,
    });
  }
}
