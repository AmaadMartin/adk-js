/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GCSCapability,
  GcsToolResult,
  GCSToolSettings,
  GcsToolStatus,
} from './types.js';

/** Access levels granted by a {@link GCSToolSettings}. */
export interface GcsAccess {
  read: boolean;
  write: boolean;
}

/**
 * Resolves the access a settings object grants, defaulting to read-only when
 * no capabilities were configured.
 */
export function resolveAccess(settings?: GCSToolSettings): GcsAccess {
  const capabilities = settings?.capabilities ?? [GCSCapability.READ_ONLY];
  const write = capabilities.includes(GCSCapability.READ_WRITE);
  return {read: write || capabilities.includes(GCSCapability.READ_ONLY), write};
}

/** Converts a caught value into the error result every GCS tool returns. */
export function toErrorResult(error: unknown): GcsToolResult {
  return {
    status: GcsToolStatus.ERROR,
    error_details: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Reads the page token out of the `nextQuery` value returned by the Cloud
 * Storage list APIs, which type it as `{}`.
 */
export function nextPageToken(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null || !('pageToken' in query)) {
    return undefined;
  }
  return typeof query.pageToken === 'string' ? query.pageToken : undefined;
}

/** Whether a caught value is a Cloud Storage 404. */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 404
  );
}

/**
 * Decodes downloaded object bytes as UTF-8 text, falling back to base64 when
 * the payload is not valid UTF-8 so that it stays JSON-serializable.
 */
export function decodeObjectData(bytes: Buffer): {
  content: string;
  encoding: 'text' | 'base64';
} {
  try {
    return {
      content: new TextDecoder('utf-8', {fatal: true}).decode(bytes),
      encoding: 'text',
    };
  } catch {
    return {content: bytes.toString('base64'), encoding: 'base64'};
  }
}
