/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {logger} from '../utils/logger.js';

import {assertNoCaseCollision} from './artifact_filename.js';
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

    assertNoCaseCollision(
      keysInScope(
        Object.keys(this.artifacts),
        scopePrefix(appName, userId, sessionId, filename),
      ),
      filename,
    );

    const path = artifactPath(appName, userId, sessionId, filename);

    if (!this.artifacts[path]) {
      this.artifacts[path] = [];
    }

    const version = this.artifacts[path].length;
    const metadata: ArtifactVersion = {
      version,
      customMetadata,
    };

    if (!artifact.inlineData && artifact.text === undefined) {
      const fileData = artifact.fileData!;

      metadata.mimeType = fileData.mimeType;
    }

    this.artifacts[path].push({part: artifact, metadata});

    return version;
  }

  loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    if (version === undefined) {
      version = versions.length - 1;
    }

    if (!versions[version]) {
      logger.warn(
        `[InMemoryArtifactService] loadArtifact: Artifact ${filename} version ${version} not found`,
      );
      return Promise.resolve(undefined);
    }

    return Promise.resolve(versions[version].part);
  }

  listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const paths = Object.keys(this.artifacts);
    const filenames = [
      ...keysInScope(
        paths,
        artifactPrefix('session', appName, userId, sessionId),
      ),
      ...keysInScope(paths, artifactPrefix('user', appName, userId)),
    ];

    return Promise.resolve(filenames.sort());
  }

  deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    const path = artifactPath(appName, userId, sessionId, filename);
    if (!this.artifacts[path]) {
      return Promise.resolve();
    }
    delete this.artifacts[path];

    return Promise.resolve();
  }

  listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return Promise.resolve([]);
    }

    const versions: number[] = [];
    for (let i = 0; i < artifacts.length; i++) {
      versions.push(i);
    }

    return Promise.resolve(versions);
  }

  listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return Promise.resolve([]);
    }

    return Promise.resolve(artifacts.map((a) => a.metadata));
  }

  getArtifactVersion({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    if (version === undefined) {
      version = versions.length - 1;
    }

    if (versions[version]) {
      return Promise.resolve(versions[version].metadata);
    }

    return Promise.resolve(undefined);
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
  const prefix = scopePrefix(appName, userId, sessionId, filename);

  return `${prefix}${encodeURIComponent(filename)}`;
}

/**
 * Constructs the storage key prefix shared by every artifact in the scope the
 * filename belongs to.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @return The encoded storage key prefix for the scope.
 */
function scopePrefix(
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
): string {
  return fileHasUserNamespace(filename)
    ? artifactPrefix('user', appName, userId)
    : artifactPrefix('session', appName, userId, sessionId);
}

function artifactPrefix(scope: string, ...parts: string[]): string {
  return `${[scope, ...parts].map(encodeURIComponent).join('/')}/`;
}

/**
 * Extracts the artifact filenames stored under a scope's storage key prefix.
 *
 * @param paths The storage keys to filter.
 * @param prefix The scope's storage key prefix.
 * @return The filenames of the artifacts stored in the scope.
 */
function keysInScope(paths: Iterable<string>, prefix: string): string[] {
  const filenames: string[] = [];
  for (const path of paths) {
    if (path.startsWith(prefix)) {
      filenames.push(decodeURIComponent(path.slice(prefix.length)));
    }
  }

  return filenames;
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
