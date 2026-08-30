/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Readable-text extraction from an HTML document. */

import {DefaultTreeAdapterTypes, defaultTreeAdapter, parse} from 'parse5';

/**
 * Element subtrees whose text is code or markup rather than page content.
 *
 * BeautifulSoup's `get_text` keeps `<script>` and `<style>` text. Dropping it
 * is a deliberate divergence: feeding JavaScript source to a model is not
 * behaviour worth reproducing.
 */
const NON_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript']);

/** Appends every text node under `node` to `lines`, in document order. */
function collectText(
  node: DefaultTreeAdapterTypes.ParentNode,
  lines: string[],
): void {
  for (const child of node.childNodes) {
    if (defaultTreeAdapter.isTextNode(child)) {
      const text = child.value.trim();
      if (text) {
        lines.push(text);
      }
    } else if (
      defaultTreeAdapter.isElementNode(child) &&
      !NON_TEXT_ELEMENTS.has(defaultTreeAdapter.getTagName(child))
    ) {
      collectText(child, lines);
    }
  }
}

/**
 * Extracts readable text from an HTML document, mirroring BeautifulSoup's
 * `get_text(separator='\n', strip=True)`: every text node in document order,
 * trimmed, empties dropped, joined with newlines.
 *
 * The parser decodes character references and tolerates malformed markup, so
 * an attribute value that contains `>` cannot leak into the output.
 */
export function htmlToText(html: string): string {
  const lines: string[] = [];
  collectText(parse(html), lines);
  return lines.join('\n');
}
