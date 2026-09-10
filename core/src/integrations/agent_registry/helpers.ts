/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reports whether a URL names a Google API endpoint reachable over https.
 *
 * The scheme check is what keeps a caller from attaching an Application
 * Default Credentials bearer token to a plaintext endpoint.
 */
export function isGoogleApi(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'googleapis.com' ||
        parsed.hostname.endsWith('.googleapis.com'))
    );
  } catch {
    return false;
  }
}

export function cleanName(name: string): string {
  let clean = name.replace(/[^a-zA-Z0-9_]/g, '_');
  clean = clean.replace(/_+/g, '_');
  clean = clean.replace(/^_+|_+$/g, '');
  if (clean && !/^[a-zA-Z_]/.test(clean)) {
    clean = '_' + clean;
  }
  return clean;
}
