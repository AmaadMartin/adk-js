/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';

/**
 * Returns whether a part carries content an artifact service can store.
 *
 * Presence is tested against null and undefined rather than falsiness, because
 * an empty string is valid text content and an empty inline payload is valid
 * binary content.
 *
 * @param artifact The part a caller wants to save.
 * @return True if at least one content field is present.
 */
export function hasArtifactContent(artifact: Part): boolean {
  return (
    artifact.inlineData != null ||
    artifact.text != null ||
    artifact.fileData != null
  );
}
