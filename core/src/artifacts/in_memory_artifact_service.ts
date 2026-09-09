/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';

import {
  ArtifactScope,
  ParsedArtifactUri,
  ensurePart,
  isArtifactRef,
  parseArtifactUri,
  validateArtifactReferenceScope,
  validatePathSegment,
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

/**
 * The longest chain of references a load follows before it is rejected.
 *
 * A stored reference may point at another reference, and at itself, so the
 * chain needs a bound.
 */
const MAX_ARTIFACT_REFERENCE_DEPTH = 10;

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

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    const {appName, userId, sessionId, filename, customMetadata} = request;
    const artifact = ensurePart(request.artifact);
    const scope: ArtifactScope = {appName, userId, sessionId};
    const path = artifactPath(scope, filename);

    const versions = this.artifacts[path] ?? [];
    const version = versions.length;
    const metadata: ArtifactVersion = {
      version,
      canonicalUri: canonicalUri(scope, filename, version),
      customMetadata,
    };

    if (artifact.inlineData) {
      metadata.mimeType = artifact.inlineData.mimeType;
    } else if (artifact.text !== undefined) {
      metadata.mimeType = 'text/plain';
    } else if (artifact.fileData) {
      if (isArtifactRef(artifact)) {
        // A reference carries no mime type; it is known once resolved.
        referenceTarget(scope, artifact.fileData.fileUri);
      } else {
        metadata.mimeType = artifact.fileData.mimeType;
      }
    } else {
      throw new InputValidationError(
        'Artifact must have either inlineData or text content.',
      );
    }

    versions.push({part: artifact, metadata});
    this.artifacts[path] = versions;

    return version;
  }

  async loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    return this.loadVersion({appName, userId, sessionId}, filename, version, 0);
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
    const path = artifactPath({appName, userId, sessionId}, filename);
    delete this.artifacts[path];
  }

  async listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const path = artifactPath({appName, userId, sessionId}, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return [];
    }

    return artifacts.map((_, index) => index);
  }

  async listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    const path = artifactPath({appName, userId, sessionId}, filename);
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
    const path = artifactPath({appName, userId, sessionId}, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return undefined;
    }

    return versions[version ?? versions.length - 1]?.metadata;
  }

  /**
   * Loads one stored version, and follows an artifact reference when it finds
   * one.
   *
   * @param scope The scope the caller operates in.
   * @param filename The name of the artifact file.
   * @param version The version to load, or undefined for the latest one.
   * @param depth The number of references already followed.
   * @return The artifact, or undefined when it is missing or has no content.
   */
  private async loadVersion(
    scope: ArtifactScope,
    filename: string,
    version: number | undefined,
    depth: number,
  ): Promise<Part | undefined> {
    const path = artifactPath(scope, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return undefined;
    }

    const entry = versions[version ?? versions.length - 1];
    if (!entry) {
      logger.warn(
        `[InMemoryArtifactService] loadArtifact: Artifact ${filename} version ${version} not found`,
      );
      return undefined;
    }

    const part = entry.part;
    if (isArtifactRef(part)) {
      const fileUri = part.fileData.fileUri;
      const target = referenceTarget(scope, fileUri);
      if (depth >= MAX_ARTIFACT_REFERENCE_DEPTH) {
        throw new InputValidationError(
          `Artifact reference chain exceeded the maximum depth of ${MAX_ARTIFACT_REFERENCE_DEPTH}: ${fileUri}`,
        );
      }
      return this.loadVersion(
        {
          appName: target.appName,
          userId: target.userId,
          sessionId: target.sessionId,
        },
        target.filename,
        target.version,
        depth + 1,
      );
    }

    return isEmptyArtifact(part) ? undefined : part;
  }
}

/**
 * Parses the reference a stored artifact holds, and rejects one the caller may
 * not follow.
 *
 * @param scope The scope the caller operates in.
 * @param fileUri The `artifact://` URI the artifact carries.
 * @return The parsed reference.
 * @throws InputValidationError When the URI is malformed or out of scope.
 */
function referenceTarget(
  scope: ArtifactScope,
  fileUri: string,
): ParsedArtifactUri {
  const parsedUri = parseArtifactUri(fileUri);
  if (!parsedUri) {
    throw new InputValidationError(
      `Invalid artifact reference URI: ${fileUri}`,
    );
  }
  validateArtifactReferenceScope(scope, parsedUri);
  return parsedUri;
}

/**
 * Reports whether a stored artifact carries no content.
 *
 * @param part The stored artifact.
 * @return True for an empty part, an empty text, or inline data with no bytes.
 */
function isEmptyArtifact(part: Part): boolean {
  if (part.inlineData) {
    return !part.inlineData.data;
  }
  return Object.values(part).every(
    (value) => value === undefined || value === '',
  );
}

/**
 * Builds the URI that names where this service keeps one version.
 *
 * A user-namespaced artifact belongs to the user rather than to the session
 * that saved it, so its URI carries no session.
 *
 * @param scope The scope the caller operates in.
 * @param filename The name of the artifact file.
 * @param version The version being saved.
 * @return The canonical URI.
 */
function canonicalUri(
  scope: ArtifactScope,
  filename: string,
  version: number,
): string {
  const {appName, userId, sessionId} = scope;
  if (fileHasUserNamespace(filename)) {
    return `memory://apps/${appName}/users/${userId}/artifacts/${filename}/versions/${version}`;
  }
  return `memory://apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${filename}/versions/${version}`;
}

/**
 * Constructs the storage key for the artifact.
 *
 * @param scope The scope the caller operates in.
 * @param filename The filename.
 * @return The encoded storage key for the artifact.
 * @throws InputValidationError When an identifier could alter the key, or when
 *     a session-scoped artifact has no session.
 */
function artifactPath(scope: ArtifactScope, filename: string): string {
  const {appName, userId, sessionId} = scope;
  validatePathSegment(appName, 'appName');
  validatePathSegment(userId, 'userId');

  if (fileHasUserNamespace(filename)) {
    return `${artifactPrefix('user', appName, userId)}${encodeURIComponent(filename)}`;
  }

  if (sessionId === undefined) {
    throw new InputValidationError(
      'Session ID must be provided for session-scoped artifacts.',
    );
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
