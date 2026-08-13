/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

/**
 * The result of parsing an artifact URI.
 */
export interface ParsedArtifactUri {
  appName: string;
  userId: string;
  /** Undefined for a user-scoped reference. */
  sessionId?: string;
  filename: string;
  version: number;
}

const ARTIFACT_URI_SCHEME = 'artifact://';

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

const SESSION_SCOPED_ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)\/sessions\/([^/]+)\/artifacts\/(.+)\/versions\/(\d+)$/;

const USER_SCOPED_ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)\/artifacts\/(.+)\/versions\/(\d+)$/;

/**
 * The longest chain of references a load may follow before it is rejected.
 *
 * A stored reference may point at another reference, and a reference may point
 * at itself, so the chain needs a bound.
 */
const MAX_ARTIFACT_REFERENCE_DEPTH = 10;

// These rejections should become InputValidationError once adk-js ports the
// typed error module; the services throw plain Error today.

/**
 * Parses an artifact URI.
 *
 * @param uri The artifact URI to parse.
 * @return The parsed URI, or undefined when the URI does not match the grammar.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | undefined {
  if (!isArtifactUri(uri)) {
    return undefined;
  }

  const sessionScoped = SESSION_SCOPED_ARTIFACT_URI_RE.exec(uri);
  if (sessionScoped) {
    return {
      appName: sessionScoped[1],
      userId: sessionScoped[2],
      sessionId: sessionScoped[3],
      filename: sessionScoped[4],
      version: Number.parseInt(sessionScoped[5], 10),
    };
  }

  const userScoped = USER_SCOPED_ARTIFACT_URI_RE.exec(uri);
  if (userScoped) {
    return {
      appName: userScoped[1],
      userId: userScoped[2],
      filename: userScoped[3],
      version: Number.parseInt(userScoped[4], 10),
    };
  }

  return undefined;
}

/**
 * Constructs an artifact URI.
 *
 * @param params The scope, filename and version the URI names. The URI is
 *     user-scoped unless a non-empty `sessionId` is given.
 * @return The constructed artifact URI.
 */
export function getArtifactUri({
  appName,
  userId,
  sessionId,
  filename,
  version,
}: {
  appName: string;
  userId: string;
  sessionId?: string;
  filename: string;
  version: number;
}): string {
  if (sessionId) {
    return `${ARTIFACT_URI_SCHEME}apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${filename}/versions/${version}`;
  }
  return `${ARTIFACT_URI_SCHEME}apps/${appName}/users/${userId}/artifacts/${filename}/versions/${version}`;
}

/**
 * Checks whether a stored file URI references another artifact rather than an
 * external file.
 *
 * @param uri The file URI to check.
 * @return True if the URI uses the artifact scheme.
 */
export function isArtifactUri(uri: string | undefined): uri is string {
  return uri !== undefined && uri.startsWith(ARTIFACT_URI_SCHEME);
}

/**
 * Checks whether an artifact part is an artifact reference.
 *
 * @param artifact The artifact part to check.
 * @return True if the part references another artifact.
 */
export function isArtifactRef(artifact: Part): boolean {
  return isArtifactUri(artifact.fileData?.fileUri);
}

/**
 * Parses a reference that the caller is allowed to follow.
 *
 * @param params The caller's scope and the referencing file URI.
 * @return The parsed URI.
 * @throws Error if the URI is malformed or names another scope.
 */
export function parseArtifactReference({
  appName,
  userId,
  sessionId,
  fileUri,
}: {
  appName: string;
  userId: string;
  sessionId: string | undefined;
  fileUri: string;
}): ParsedArtifactUri {
  const parsedUri = parseArtifactUri(fileUri);
  if (!parsedUri) {
    throw new Error(`Invalid artifact reference URI: ${fileUri}`);
  }
  validateArtifactReferenceScope({appName, userId, sessionId, parsedUri});
  return parsedUri;
}

/**
 * Ensures artifact references cannot escape the caller's scope.
 *
 * @param params The caller's scope and the parsed reference.
 * @throws Error if the reference names another app, user or session.
 */
export function validateArtifactReferenceScope({
  appName,
  userId,
  sessionId,
  parsedUri,
}: {
  appName: string;
  userId: string;
  sessionId: string | undefined;
  parsedUri: ParsedArtifactUri;
}): void {
  if (parsedUri.appName !== appName || parsedUri.userId !== userId) {
    throw new Error(
      'Artifact references must stay within the same app and user scope.',
    );
  }
  if (parsedUri.sessionId !== undefined && parsedUri.sessionId !== sessionId) {
    throw new Error(
      'Session-scoped artifact references must stay within the same session scope.',
    );
  }
}

/**
 * Ensures a chain of references terminates.
 *
 * @param depth The number of references already followed.
 * @param fileUri The reference about to be followed.
 * @throws Error if the chain is longer than the supported depth.
 */
export function assertArtifactReferenceDepth(
  depth: number,
  fileUri: string,
): void {
  if (depth >= MAX_ARTIFACT_REFERENCE_DEPTH) {
    throw new Error(
      `Artifact reference chain exceeded the maximum depth of ${MAX_ARTIFACT_REFERENCE_DEPTH}: ${fileUri}`,
    );
  }
}

function isDriveQualified(value: string): boolean {
  return WINDOWS_DRIVE_RE.test(value);
}

/**
 * Rejects values that could alter the constructed storage path.
 *
 * @param value The caller-supplied identifier (e.g. userId or sessionId).
 * @param fieldName Human-readable name used in the error message.
 * @throws Error if the value is empty, contains a null byte or traversal
 *     segments, starts with a slash, or is drive-qualified.
 */
export function validatePathSegment(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  if (value.includes('\x00')) {
    throw new Error(`${fieldName} must not contain null bytes.`);
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw new Error(
      `${fieldName} '${value}' must not be an absolute path or start with a slash.`,
    );
  }
  if (isDriveQualified(value)) {
    throw new Error(`${fieldName} '${value}' must not be drive-qualified.`);
  }
  if (
    value === '.' ||
    value === '..' ||
    value.replace(/\\/g, '/').split('/').includes('..')
  ) {
    throw new Error(
      `${fieldName} '${value}' must not contain traversal segments.`,
    );
  }
}
