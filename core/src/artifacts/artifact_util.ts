/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';

/** The URI scheme that marks a `Part` as a reference to another artifact. */
export const ARTIFACT_URI_SCHEME = 'artifact://';

const SESSION_SCOPED_ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)\/sessions\/([^/]+)\/artifacts\/(.+)\/versions\/(\d+)$/;
const USER_SCOPED_ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)\/artifacts\/(.+)\/versions\/(\d+)$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/** The result of parsing an artifact URI. */
export interface ParsedArtifactUri {
  /** The name of the application that owns the artifact. */
  appName: string;
  /** The ID of the user that owns the artifact. */
  userId: string;
  /** The ID of the session, absent for a user-scoped artifact. */
  sessionId?: string;
  /** The name of the artifact file. */
  filename: string;
  /** The version of the artifact. */
  version: number;
}

/** The parameters for {@link getArtifactUri}. */
export interface GetArtifactUriRequest {
  /** The name of the application that owns the artifact. */
  appName: string;
  /** The ID of the user that owns the artifact. */
  userId: string;
  /** The name of the artifact file. */
  filename: string;
  /** The version of the artifact. */
  version: number;
  /** The ID of the session. Omit it for a user-scoped artifact. */
  sessionId?: string;
}

/** The parameters for {@link validateArtifactReferenceScope}. */
export interface ValidateArtifactReferenceScopeRequest {
  /** The application the caller is operating in. */
  appName: string;
  /** The user the caller is operating as. */
  userId: string;
  /** The session the caller is operating in, if any. */
  sessionId?: string;
  /** The reference to check against the caller's scope. */
  parsedUri: ParsedArtifactUri;
}

/**
 * Parses an artifact URI.
 *
 * @param uri The artifact URI to parse.
 * @return The parsed URI, or undefined when the URI is not an artifact URI.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | undefined {
  if (!uri || !uri.startsWith(ARTIFACT_URI_SCHEME)) {
    return undefined;
  }

  const sessionScoped = SESSION_SCOPED_ARTIFACT_URI_RE.exec(uri);
  if (sessionScoped) {
    return {
      appName: sessionScoped[1],
      userId: sessionScoped[2],
      sessionId: sessionScoped[3],
      filename: sessionScoped[4],
      version: Number(sessionScoped[5]),
    };
  }

  const userScoped = USER_SCOPED_ARTIFACT_URI_RE.exec(uri);
  if (userScoped) {
    return {
      appName: userScoped[1],
      userId: userScoped[2],
      filename: userScoped[3],
      version: Number(userScoped[4]),
    };
  }

  return undefined;
}

/**
 * Constructs an artifact URI.
 *
 * @param request The artifact to point at.
 * @return The constructed artifact URI.
 */
export function getArtifactUri(request: GetArtifactUriRequest): string {
  const {appName, userId, filename, version, sessionId} = request;
  if (sessionId) {
    return `${ARTIFACT_URI_SCHEME}apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${filename}/versions/${version}`;
  }
  return `${ARTIFACT_URI_SCHEME}apps/${appName}/users/${userId}/artifacts/${filename}/versions/${version}`;
}

/**
 * Checks whether a part points at another artifact.
 *
 * @param artifact The part to check.
 * @return True when the part carries an `artifact://` file URI.
 */
export function isArtifactRef(artifact: Part): boolean {
  return Boolean(artifact.fileData?.fileUri?.startsWith(ARTIFACT_URI_SCHEME));
}

/**
 * Ensures an artifact reference cannot escape the caller's scope.
 *
 * @param request The caller's scope and the reference to check.
 * @throws InputValidationError When the reference names another app, another
 *     user, or another session.
 */
export function validateArtifactReferenceScope(
  request: ValidateArtifactReferenceScopeRequest,
): void {
  const {appName, userId, sessionId, parsedUri} = request;
  if (parsedUri.appName !== appName || parsedUri.userId !== userId) {
    throw new InputValidationError(
      'Artifact references must stay within the same app and user scope.',
    );
  }
  if (parsedUri.sessionId !== undefined && parsedUri.sessionId !== sessionId) {
    throw new InputValidationError(
      'Session-scoped artifact references must stay within the same session scope.',
    );
  }
}

/**
 * Rejects values that could alter the constructed artifact path.
 *
 * @param value The caller-supplied identifier, such as a user ID.
 * @param fieldName The name used in the error message.
 * @throws InputValidationError When the value is empty, contains a null byte,
 *     is an absolute path, is drive-qualified, or contains a traversal
 *     segment.
 */
export function validatePathSegment(value: string, fieldName: string): void {
  if (!value) {
    throw new InputValidationError(`${fieldName} must not be empty.`);
  }
  if (value.includes('\u0000')) {
    throw new InputValidationError(`${fieldName} must not contain null bytes.`);
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not be an absolute path or start with a slash.`,
    );
  }
  if (WINDOWS_DRIVE_RE.test(value)) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not be drive-qualified.`,
    );
  }
  if (
    value === '.' ||
    value === '..' ||
    value.replace(/\\/g, '/').split('/').includes('..')
  ) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not contain traversal segments.`,
    );
  }
}
