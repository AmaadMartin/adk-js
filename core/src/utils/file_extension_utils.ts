/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  FileContentEncoding,
} from '../code_executors/code_execution_utils.js';

const MIME_TYPE_MAP: Record<
  string,
  {mimeType: string; encoding: FileContentEncoding}
> = {
  '.js': {mimeType: 'text/javascript', encoding: FileContentEncoding.UTF8},
  '.py': {mimeType: 'text/x-python', encoding: FileContentEncoding.UTF8},
  '.md': {mimeType: 'text/markdown', encoding: FileContentEncoding.UTF8},
  '.txt': {mimeType: 'text/plain', encoding: FileContentEncoding.UTF8},
  '.html': {mimeType: 'text/html', encoding: FileContentEncoding.UTF8},
  '.css': {mimeType: 'text/css', encoding: FileContentEncoding.UTF8},
  '.json': {mimeType: 'application/json', encoding: FileContentEncoding.UTF8},
  '.csv': {mimeType: 'text/csv', encoding: FileContentEncoding.UTF8},
  '.svg': {mimeType: 'image/svg+xml', encoding: FileContentEncoding.UTF8},
  '.xml': {mimeType: 'application/xml', encoding: FileContentEncoding.UTF8},
  '.yaml': {mimeType: 'text/yaml', encoding: FileContentEncoding.UTF8},
  '.yml': {mimeType: 'text/yaml', encoding: FileContentEncoding.UTF8},
  '.png': {mimeType: 'image/png', encoding: FileContentEncoding.BASE64},
  '.jpg': {mimeType: 'image/jpeg', encoding: FileContentEncoding.BASE64},
  '.jpeg': {mimeType: 'image/jpeg', encoding: FileContentEncoding.BASE64},
  '.pdf': {mimeType: 'application/pdf', encoding: FileContentEncoding.BASE64},
};

const EXTENSION_TO_LANGUAGE: Record<string, CodeExecutionLanguage> = {
  '.js': CodeExecutionLanguage.JAVASCRIPT,
  '.ts': CodeExecutionLanguage.TYPESCRIPT,
  '.py': CodeExecutionLanguage.PYTHON,
  '.bat': CodeExecutionLanguage.WINDOWS_CMD,
  '.cmd': CodeExecutionLanguage.WINDOWS_CMD,
  '.ps1': CodeExecutionLanguage.POWERSHELL,
  '.sh': CodeExecutionLanguage.SHELL,
};

/**
 * Gets the MIME type and file content encoding for a given file extension.
 * @param ext The file extension (e.g., '.js', '.png').
 * @returns An object containing the mimeType and encoding.
 */
export function getMimeTypeAndEncoding(ext: string): {
  mimeType: string;
  encoding: FileContentEncoding;
} {
  return (
    MIME_TYPE_MAP[ext.toLowerCase()] || {
      mimeType: 'application/octet-stream',
      encoding: FileContentEncoding.BASE64,
    }
  );
}

/**
 * Gets the code execution language for a given file extension.
 * @param ext The file extension (e.g., '.js', '.py').
 * @returns The code execution language.
 */
export function getScriptLanguageByExtension(
  ext: string,
): CodeExecutionLanguage {
  return (
    EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ||
    CodeExecutionLanguage.UNSPECIFIED
  );
}

/** The MIME type {@link getMimeTypeAndEncoding} returns for an unknown one. */
const UNKNOWN_MIME_TYPE = 'application/octet-stream';

/** Major MIME types that name a kind of media. */
const MEDIA_KIND_BY_MAJOR_MIME_TYPE: Record<string, 'image' | 'video'> = {
  image: 'image',
  video: 'video',
};

/** Drops parameters and casing from a MIME type so it can be compared. */
export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

/**
 * Returns the kind of media a MIME type names, or undefined when it names
 * something else. Audio is absent: it is not addressable by URL everywhere
 * image and video are, so callers handle it separately.
 */
export function mediaKindFromMimeType(
  mimeType: string,
): 'image' | 'video' | undefined {
  return MEDIA_KIND_BY_MAJOR_MIME_TYPE[
    normalizeMimeType(mimeType).split('/', 1)[0]
  ];
}

/**
 * Maps an audio MIME type to its common format name, so that `audio/mpeg`
 * becomes `mp3` and `audio/x-wav` becomes `wav`.
 */
export function audioFormatFromMimeType(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  let subtype = normalized.slice(normalized.indexOf('/') + 1);
  if (subtype.startsWith('x-')) {
    subtype = subtype.slice(2);
  }
  if (subtype === 'mpeg') {
    return 'mp3';
  }
  if (subtype === 'wave' || subtype === 'vnd.wave') {
    return 'wav';
  }
  return subtype;
}

/**
 * Guesses a MIME type from a file name, returning undefined when the extension
 * is unknown or absent.
 */
export function guessMimeTypeFromFileName(
  fileName: string,
): string | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const {mimeType} = getMimeTypeAndEncoding(fileName.slice(dot));
  return mimeType === UNKNOWN_MIME_TYPE ? undefined : mimeType;
}

/**
 * Returns the path component of a URI, tolerating a string that is not a valid
 * absolute URL.
 */
function uriPath(uri: string): string {
  try {
    return new URL(uri).pathname;
  } catch {
    return uri.split('?', 1)[0].split('#', 1)[0];
  }
}

/**
 * Infers a MIME type from the file extension in a URI.
 *
 * Artifact URIs are versioned (`.../report.pdf/versions/3`), so a trailing
 * numeric segment and the `versions` segment before it are dropped before the
 * remaining segment is read as a file name.
 */
export function inferMimeTypeFromUri(uri: string): string | undefined {
  const segments = uriPath(uri).split('/').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  if (/^\d+$/.test(segments[segments.length - 1])) {
    segments.pop();
    const previous = segments[segments.length - 1]?.toLowerCase();
    if (previous === 'versions' || previous === 'version') {
      segments.pop();
    }
  }
  const candidate = segments[segments.length - 1];
  return candidate ? guessMimeTypeFromFileName(candidate) : undefined;
}
