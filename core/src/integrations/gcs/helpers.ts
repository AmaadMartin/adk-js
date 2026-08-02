/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GcsCapability,
  GcsToolResult,
  GcsToolSettings,
  GcsToolStatus,
} from './types.js';

/**
 * Resolves the access a settings object grants, defaulting to read-only when
 * no capabilities were configured.
 */
export function resolveAccess(settings?: GcsToolSettings): {
  read: boolean;
  write: boolean;
} {
  const capabilities = settings?.capabilities ?? [GcsCapability.READ_ONLY];
  const write = capabilities.includes(GcsCapability.READ_WRITE);
  return {read: write || capabilities.includes(GcsCapability.READ_ONLY), write};
}

/** Converts a caught value into the error result every GCS tool returns. */
export function toErrorResult(error: unknown): GcsToolResult {
  return {
    status: GcsToolStatus.ERROR,
    error_details: error instanceof Error ? error.message : String(error),
  };
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
 * Query options that make a Cloud Storage list call return exactly one page,
 * mirroring adk-python's single `next(pages)` read.
 */
export function pageOptions(pageSize?: number, pageToken?: string) {
  return {
    ...(pageSize !== undefined
      ? {maxResults: pageSize, autoPaginate: false}
      : {}),
    ...(pageToken !== undefined ? {pageToken} : {}),
  };
}

/**
 * Reads the page token out of the `nextQuery` value returned by the Cloud
 * Storage list APIs, which type it as `{}`.
 */
function nextPageToken(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null || !('pageToken' in query)) {
    return undefined;
  }
  return typeof query.pageToken === 'string' ? query.pageToken : undefined;
}

/**
 * Builds the result of a list call, carrying the next page token only when
 * paging was requested and the API returned one.
 */
export function listResult(
  names: string[],
  nextQuery: unknown,
  pageSize?: number,
): GcsToolResult {
  const token = pageSize !== undefined ? nextPageToken(nextQuery) : undefined;
  return {
    status: GcsToolStatus.SUCCESS,
    results: names,
    ...(token ? {next_page_token: token} : {}),
  };
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
