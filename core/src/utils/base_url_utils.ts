/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A base URL split into an endpoint and the API version it carried. */
export interface NormalizedBaseUrl {
  /** The base URL, with a recognized version path suffix removed. */
  baseUrl?: string;
  /** The version lifted out of the path, e.g. `v1alpha`. */
  apiVersion?: string;
}

const GOOGLE_API_HOST_SUFFIX = '.googleapis.com';
const GOOGLE_API_VERSION_SUFFIX_PATTERN = /^\/?(v[0-9][a-z0-9.-]*)\/?$/;

/**
 * Extracts a Google API version suffix from a base URL when present.
 *
 * Only a `*.googleapis.com` URL whose whole path is a version segment is
 * split. Everything else — another host, a query string, a fragment, a longer
 * path, or a string the URL parser rejects — is returned unchanged with no
 * version, so the SDK's own default applies.
 *
 * @param baseUrl The configured base URL, if any.
 * @returns The endpoint and the version it carried.
 */
export function normalizeBaseUrlAndApiVersion(
  baseUrl?: string,
): NormalizedBaseUrl {
  if (!baseUrl) {
    return {};
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return {baseUrl};
  }

  if (
    !url.hostname.endsWith(GOOGLE_API_HOST_SUFFIX) ||
    url.search ||
    url.hash
  ) {
    return {baseUrl};
  }

  const versionMatch = GOOGLE_API_VERSION_SUFFIX_PATTERN.exec(url.pathname);
  if (!versionMatch) {
    return {baseUrl};
  }

  // The query and fragment are already known empty, so dropping the path is
  // all the normalized URL needs.
  url.pathname = '/';
  return {baseUrl: url.toString(), apiVersion: versionMatch[1]};
}
