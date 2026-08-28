/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strips the parameters from a MIME type, so that `text/csv; charset=utf-8`
 * becomes `text/csv`.
 *
 * A MIME type that carries parameters does not compare equal to its base type,
 * so any lookup keyed on the type alone has to normalize first.
 *
 * @param mimeType The MIME type to strip, with or without parameters.
 * @return The type and subtype, trimmed of surrounding whitespace.
 */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim();
}
