/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {validatePathSegment} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';

import {
  isArtifactUri,
  nextArtifactRequest,
  validateArtifactReference,
} from './artifact_util.js';
import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

export function isInMemoryConnectionString(uri: string): boolean {
  return uri === 'memory://';
}

/**
 * An in-memory implementation of the ArtifactService.
 */
export class InMemoryArtifactService implements BaseArtifactService {
  private readonly artifacts: Record<
    string,
    {part: Part; metadata: ArtifactVersion}[]
  > = {};

  async saveArtifact({
    appName,
    userId,
    sessionId,
    filename,
    artifact,
    customMetadata,
  }: SaveArtifactRequest): Promise<number> {
    if (!artifact.inlineData && !artifact.text && !artifact.fileData) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path] ?? [];
    const version = versions.length;
    const metadata: ArtifactVersion = {
      version,
      customMetadata,
    };

    if (!artifact.inlineData && artifact.text === undefined) {
      const fileData = artifact.fileData!;

      if (isArtifactUri(fileData.fileUri)) {
        // A reference carries no mime type; it is known once resolved.
        validateArtifactReference({
          appName,
          userId,
          sessionId,
          fileUri: fileData.fileUri,
        });
      } else {
        metadata.mimeType = fileData.mimeType;
      }
    }

    versions.push({part: artifact, metadata});
    this.artifacts[path] = versions;

    return version;
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    return this.loadArtifactAtDepth(request, 0);
  }

  private async loadArtifactAtDepth(
    request: LoadArtifactRequest,
    depth: number,
  ): Promise<Part | undefined> {
    const {appName, userId, sessionId, filename} = request;
    let {version} = request;
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return undefined;
    }

    if (version === undefined) {
      version = versions.length - 1;
    }

    if (!versions[version]) {
      logger.warn(
        `[InMemoryArtifactService] loadArtifact: Artifact ${filename} version ${version} not found`,
      );
      return undefined;
    }

    const part = versions[version].part;
    const fileUri = part.fileData?.fileUri;

    if (isArtifactUri(fileUri)) {
      return this.loadArtifactAtDepth(
        nextArtifactRequest(request, fileUri, depth),
        depth + 1,
      );
    }

    return part;
  }

  async listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    validatePathSegment(appName, 'appName');
    validatePathSegment(userId, 'userId');
    validatePathSegment(sessionId, 'sessionId');

    const sessionPrefix = artifactPrefix('session', appName, userId, sessionId);
    const userPrefix = artifactPrefix('user', appName, userId);
    const filenames: string[] = [];

    for (const path in this.artifacts) {
      if (path.startsWith(sessionPrefix)) {
        filenames.push(decodeURIComponent(path.slice(sessionPrefix.length)));
      } else if (path.startsWith(userPrefix)) {
        filenames.push(decodeURIComponent(path.slice(userPrefix.length)));
      }
    }

    return filenames.sort();
  }

  async deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    const path = artifactPath(appName, userId, sessionId, filename);
    if (!this.artifacts[path]) {
      return;
    }
    delete this.artifacts[path];
  }

  async listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return [];
    }

    const versions: number[] = [];
    for (let i = 0; i < artifacts.length; i++) {
      versions.push(i);
    }

    return versions;
  }

  async listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return [];
    }

    return artifacts.map((a) => a.metadata);
  }

  async getArtifactVersion({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return undefined;
    }

    if (version === undefined) {
      version = versions.length - 1;
    }

    if (versions[version]) {
      return versions[version].metadata;
    }

    return undefined;
  }
}

/**
 * Constructs the storage key for the artifact.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @return The encoded storage key for the artifact.
 */
function artifactPath(
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
): string {
  validatePathSegment(appName, 'appName');
  validatePathSegment(userId, 'userId');

  if (fileHasUserNamespace(filename)) {
    return `${artifactPrefix('user', appName, userId)}${encodeURIComponent(filename)}`;
  }

  validatePathSegment(sessionId, 'sessionId');

  return `${artifactPrefix('session', appName, userId, sessionId)}${encodeURIComponent(filename)}`;
}

function artifactPrefix(scope: string, ...parts: string[]): string {
  return `${[scope, ...parts].map(encodeURIComponent).join('/')}/`;
}

/**
 * Checks if the filename has a user namespace prefix.
 *
 * @param filename The filename to check.
 * @return true if the filename has a user namespace (starts with "user:") false
 *     otherwise.
 */
function fileHasUserNamespace(filename: string): boolean {
  return filename.startsWith('user:');
}
