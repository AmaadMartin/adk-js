/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileData, Part} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';

/** The result of parsing an artifact URI. */
export interface ParsedArtifactUri {
  appName: string;
  userId: string;
  /** Undefined for a user-scoped reference. */
  sessionId?: string;
  filename: string;
  version: number;
}

/** An artifact that references another artifact. */
export interface ArtifactRefPart extends Part {
  fileData: FileData & {fileUri: string};
}

/** The app, user and session an artifact operation runs under. */
export interface ArtifactScope {
  appName: string;
  userId: string;
  /** Undefined for a user-scoped artifact. */
  sessionId?: string;
}

const ARTIFACT_URI_SCHEME = 'artifact://';

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/** The session segment is absent from a user-scoped reference. */
const ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)(?:\/sessions\/([^/]+))?\/artifacts\/(.+)\/versions\/(\d+)$/;

/**
 * Parses an artifact URI.
 *
 * @param uri The artifact URI to parse.
 * @return The parsed URI, or undefined when the URI does not match the grammar.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | undefined {
  const match = ARTIFACT_URI_RE.exec(uri);
  if (!match) {
    return undefined;
  }
  return {
    appName: match[1],
    userId: match[2],
    sessionId: match[3],
    filename: match[4],
    version: Number.parseInt(match[5], 10),
  };
}

/**
 * Reports whether a URI addresses another artifact.
 *
 * @param uri The file URI an artifact carries.
 * @return True when the URI uses the `artifact://` scheme.
 */
export function isArtifactUri(uri: string): boolean {
  return uri.startsWith(ARTIFACT_URI_SCHEME);
}

/**
 * Reports whether an artifact references another artifact.
 *
 * @param artifact The artifact part to check.
 * @return True when the part carries an `artifact://` file URI.
 */
export function isArtifactRef(artifact: Part): artifact is ArtifactRefPart {
  const fileUri = artifact.fileData?.fileUri;
  return fileUri !== undefined && isArtifactUri(fileUri);
}

/**
 * Rejects a reference that leaves the caller's scope.
 *
 * A user-scoped reference carries no session, so any session of the same user
 * may follow it. A session-scoped reference is readable only from the session
 * that owns it.
 *
 * @param scope The scope the caller operates in.
 * @param parsedUri The parsed reference URI.
 * @throws InputValidationError When the reference names another app, user or
 *     session.
 */
export function validateArtifactReferenceScope(
  scope: ArtifactScope,
  parsedUri: ParsedArtifactUri,
): void {
  if (
    parsedUri.appName !== scope.appName ||
    parsedUri.userId !== scope.userId
  ) {
    throw new InputValidationError(
      'Artifact references must stay within the same app and user scope.',
    );
  }
  if (
    parsedUri.sessionId !== undefined &&
    parsedUri.sessionId !== scope.sessionId
  ) {
    throw new InputValidationError(
      'Session-scoped artifact references must stay within the same session scope.',
    );
  }
}

/**
 * Rejects a value that would alter the path it is built into.
 *
 * @param value The caller-supplied identifier, such as a user ID.
 * @param fieldName The name of the field, used in the error message.
 * @throws InputValidationError When the value is empty, holds a null byte,
 *     starts with a slash, is drive-qualified, or holds a traversal segment.
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
      `${fieldName} ${JSON.stringify(value)} must not be an absolute path or start with a slash.`,
    );
  }
  if (WINDOWS_DRIVE_RE.test(value)) {
    throw new InputValidationError(
      `${fieldName} ${JSON.stringify(value)} must not be drive-qualified.`,
    );
  }
  if (
    value === '.' ||
    value === '..' ||
    value.replace(/\\/g, '/').split('/').includes('..')
  ) {
    throw new InputValidationError(
      `${fieldName} ${JSON.stringify(value)} must not contain traversal segments.`,
    );
  }
}
