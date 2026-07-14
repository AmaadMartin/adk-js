/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {
  ArtifactKey,
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

  saveArtifact(request: SaveArtifactRequest): Promise<number> {
    if (!request.artifact.inlineData && !request.artifact.text) {
      return Promise.reject(
        new Error('Artifact must have either inlineData or text content.'),
      );
    }

    const path = artifactPath(request);

    if (!this.artifacts[path]) {
      this.artifacts[path] = [];
    }

    const version = this.artifacts[path].length;
    const metadata: ArtifactVersion = {
      version,
      customMetadata: request.customMetadata,
    };
    this.artifacts[path].push({part: request.artifact, metadata});

    return Promise.resolve(version);
  }

  loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    const path = artifactPath(request);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    let version = request.version;
    if (version === undefined) {
      version = versions.length - 1;
    }

    return Promise.resolve(versions[version].part);
  }

  listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    const sessionPrefix = `${request.key.appName}/${request.key.userId}/${request.key.sessionId}/`;
    const usernamespacePrefix = `${request.key.appName}/${request.key.userId}/user/`;
    const filenames: string[] = [];

    for (const path in this.artifacts) {
      if (path.startsWith(sessionPrefix)) {
        const filename = path.replace(sessionPrefix, '');
        filenames.push(filename);
      } else if (path.startsWith(usernamespacePrefix)) {
        const filename = path.replace(usernamespacePrefix, '');
        filenames.push(filename);
      }
    }

    return Promise.resolve(filenames.sort());
  }

  deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const path = artifactPath(request);
    if (!this.artifacts[path]) {
      return Promise.resolve();
    }
    delete this.artifacts[path];

    return Promise.resolve();
  }

  listVersions(request: ListVersionsRequest): Promise<number[]> {
    const path = artifactPath(request);
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

  listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    const path = artifactPath(request);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return Promise.resolve([]);
    }

    return Promise.resolve(artifacts.map((a) => a.metadata));
  }

  getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    const path = artifactPath(request);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    let version = request.version;
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
 * Constructs the path to the artifact.
 *
 * @param request The request containing key and filename.
 * @return The path to the artifact.
 */
function artifactPath({
  key: {appName, userId, sessionId},
  filename,
}: {
  key: ArtifactKey;
  filename: string;
}): string {
  if (fileHasUserNamespace(filename)) {
    return `${appName}/${userId}/user/${filename}`;
  }

  return `${appName}/${userId}/${sessionId}/${filename}`;
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
