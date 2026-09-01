/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {logger} from '../utils/logger.js';

/** The result of parsing an artifact URI. */
export interface ParsedArtifactUri {
  appName: string;
  userId: string;
  /** Undefined for a user-scoped reference. */
  sessionId?: string;
  filename: string;
  version: number;
}

/** The app, user and session an artifact operation runs under. */
export interface ArtifactScope {
  appName: string;
  userId: string;
  /** Undefined for a user-scoped artifact. */
  sessionId?: string;
}

/**
 * A URI scheme that identifies an artifact.
 *
 * `artifact://` names a reference one artifact holds to another.
 * `memory://` names where the in-memory service keeps a version.
 */
export type ArtifactUriScheme = 'artifact://' | 'memory://';

const ARTIFACT_URI_SCHEME: ArtifactUriScheme = 'artifact://';

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

const SNAKE_CASE_KEY_RE = /_[a-z]/;

const SESSION_SCOPED_ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)\/sessions\/([^/]+)\/artifacts\/(.+)\/versions\/(\d+)$/;

const USER_SCOPED_ARTIFACT_URI_RE =
  /^artifact:\/\/apps\/([^/]+)\/users\/([^/]+)\/artifacts\/(.+)\/versions\/(\d+)$/;

/**
 * Parses an artifact URI.
 *
 * @param uri The artifact URI to parse.
 * @return The parsed URI, or undefined when the URI does not match the grammar.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | undefined {
  if (!uri.startsWith(ARTIFACT_URI_SCHEME)) {
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
 * Builds the URI that identifies one version of an artifact.
 *
 * A scope with no session produces the user-scoped form, which omits the
 * `sessions` segment.
 *
 * @param scheme The URI scheme to build the URI under.
 * @param scope The app, user and session that own the artifact.
 * @param filename The name of the artifact file.
 * @param version The version of the artifact.
 * @return The constructed URI.
 */
export function getArtifactUri(
  scheme: ArtifactUriScheme,
  scope: ArtifactScope,
  filename: string,
  version: number,
): string {
  const sessionSegment = scope.sessionId ? `sessions/${scope.sessionId}/` : '';
  return `${scheme}apps/${scope.appName}/users/${scope.userId}/${sessionSegment}artifacts/${filename}/versions/${version}`;
}

/**
 * Reports whether an artifact references another artifact.
 *
 * @param artifact The artifact part to check.
 * @return True when the part carries an `artifact://` file URI.
 */
export function isArtifactRef(artifact: Part): boolean {
  const fileUri = artifact.fileData?.fileUri;
  return fileUri !== undefined && fileUri.startsWith(ARTIFACT_URI_SCHEME);
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

/**
 * Normalizes an artifact an untyped caller supplied.
 *
 * An HTTP body or a plain JavaScript caller may name the fields the way the
 * wire format does, as `inline_data` rather than `inlineData`. A camelCase
 * object already is a `Part`, so it is returned unchanged.
 *
 * @param artifact The artifact to normalize.
 * @return The artifact with the field names the SDK expects.
 */
export function ensurePart(artifact: Part | Record<string, unknown>): Part {
  if (isCamelCasePart(artifact)) {
    return artifact;
  }
  logger.debug(
    `[artifact_util] Normalizing artifact keys to camelCase: ${Object.keys(artifact).join(', ')}`,
  );
  return camelCaseKeys(artifact) as Part;
}

/**
 * Narrows an artifact that already uses the SDK's camelCase field names.
 *
 * @param artifact The artifact to check.
 * @return True when no field name needs conversion.
 */
function isCamelCasePart(
  artifact: Part | Record<string, unknown>,
): artifact is Part {
  return !hasSnakeCaseKey(artifact);
}

/**
 * Reports whether a value, or a plain object nested in it, has a snake_case
 * field name.
 *
 * @param value The value to inspect.
 * @return True when at least one field name needs conversion.
 */
function hasSnakeCaseKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (value.constructor !== Object) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) => SNAKE_CASE_KEY_RE.test(key) || hasSnakeCaseKey(child),
  );
}
