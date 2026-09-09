/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LoadArtifactRequest} from './base_artifact_service.js';

/**
 * Helpers for the `artifact://` scheme, which lets one artifact reference
 * another instead of storing a second copy.
 *
 * Every rejection here throws a plain Error, as the artifact services do. They
 * should become InputValidationError once adk-js ports the typed error module.
 */

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

/** The caller's scope, plus the file URI that references another artifact. */
interface ArtifactReference {
  appName: string;
  userId: string;
  sessionId: string | undefined;
  fileUri: string;
}

const ARTIFACT_URI_SCHEME = 'artifact://';

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

/**
 * Parses an artifact URI.
 *
 * @param uri The artifact URI to parse.
 * @return The parsed URI, or undefined when the URI does not match the grammar.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | undefined {
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
 * Rejects a reference the caller is not allowed to follow.
 *
 * @param reference The caller's scope and the referencing file URI.
 * @throws Error if the URI is malformed or names another scope.
 */
export function validateArtifactReference(reference: ArtifactReference): void {
  parseArtifactReference(reference);
}

/**
 * Builds the request that loads the artifact a reference names.
 *
 * @param request The request being served.
 * @param fileUri The reference found in the stored artifact.
 * @param depth The number of references already followed.
 * @return The request for the referenced artifact.
 * @throws Error if the URI is malformed, names another scope, or the chain is
 *     longer than the supported depth.
 */
export function nextArtifactRequest(
  request: LoadArtifactRequest,
  fileUri: string,
  depth: number,
): LoadArtifactRequest {
  const parsedUri = parseArtifactReference({
    appName: request.appName,
    userId: request.userId,
    sessionId: request.sessionId,
    fileUri,
  });

  if (depth >= MAX_ARTIFACT_REFERENCE_DEPTH) {
    throw new Error(
      `Artifact reference chain exceeded the maximum depth of ${MAX_ARTIFACT_REFERENCE_DEPTH}: ${fileUri}`,
    );
  }

  return {
    appName: parsedUri.appName,
    userId: parsedUri.userId,
    sessionId: parsedUri.sessionId ?? request.sessionId,
    filename: parsedUri.filename,
    version: parsedUri.version,
  };
}

function parseArtifactReference({
  appName,
  userId,
  sessionId,
  fileUri,
}: ArtifactReference): ParsedArtifactUri {
  const parsedUri = parseArtifactUri(fileUri);
  if (!parsedUri) {
    throw new Error(`Invalid artifact reference URI: ${fileUri}`);
  }
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

  return parsedUri;
}
