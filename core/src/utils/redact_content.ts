/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

/**
 * Returns the content with every inline media payload removed.
 *
 * A `Part.inlineData.data` field holds a whole image, audio clip or video as
 * base64. Logging a request verbatim therefore writes megabytes of media into
 * the log, and puts user-supplied media wherever those logs are collected. The
 * MIME type is kept, so a log still says what the part was.
 *
 * The input is not modified.
 */
export function redactInlineData(content: Content): Content {
  if (!content.parts) {
    return content;
  }
  return {...content, parts: content.parts.map(redactPartInlineData)};
}

/** Returns the part with its inline media payload removed. */
function redactPartInlineData(part: Part): Part {
  if (!part.inlineData) {
    return part;
  }
  return {...part, inlineData: {...part.inlineData, data: undefined}};
}
