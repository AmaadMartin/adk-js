/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Host suffix of the Google endpoints whose version path is extracted. */
const GOOGLE_API_HOST_SUFFIX = '.googleapis.com';

/** A path that is nothing but an API version, e.g. `/v1alpha` or `/v1beta1/`. */
const GOOGLE_API_VERSION_PATH_PATTERN = /^\/?(v[0-9][a-z0-9.-]*)\/?$/;

/** A base URL and the API version its path carried, if any. */
export interface BaseUrlAndApiVersion {
  /** The base URL, with a recognized version path removed. */
  baseUrl: string | undefined;
  /** The version read from the path, or `undefined` when there was none. */
  apiVersion: string | undefined;
}

/**
 * Extracts a Google API version suffix from a base URL when present.
 *
 * A version only moves out of the path for a `*.googleapis.com` URL whose
 * whole path is a version and which carries no query or fragment. Every other
 * URL comes back unchanged with no version, so a proxy path such as
 * `https://proxy.example.com/gemini/v1alpha` keeps its shape.
 *
 * @param baseUrl The configured base URL, or `undefined`.
 * @return The base URL to send, and the version to apply alongside it.
 */
export function normalizeBaseUrlAndApiVersion(
  baseUrl: string | undefined,
): BaseUrlAndApiVersion {
  if (!baseUrl) {
    return {baseUrl: undefined, apiVersion: undefined};
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return {baseUrl, apiVersion: undefined};
  }

  if (!url.host.endsWith(GOOGLE_API_HOST_SUFFIX) || url.search || url.hash) {
    return {baseUrl, apiVersion: undefined};
  }

  const apiVersion = GOOGLE_API_VERSION_PATH_PATTERN.exec(url.pathname)?.[1];
  if (!apiVersion) {
    return {baseUrl, apiVersion: undefined};
  }

  return {baseUrl: `${url.origin}/`, apiVersion};
}
