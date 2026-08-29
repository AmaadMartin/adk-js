/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DefaultTreeAdapterTypes} from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;

/** Elements whose text is code rather than readable content. */
const NON_TEXT_ELEMENTS = new Set(['script', 'style']);

function isTextNode(node: Node): node is TextNode {
  return node.nodeName === '#text';
}

function isParentNode(node: Node): node is ParentNode {
  return 'childNodes' in node;
}

function isNonTextElement(node: ParentNode): boolean {
  return 'tagName' in node && NON_TEXT_ELEMENTS.has(node.tagName);
}

/** Appends the trimmed, non-empty text of `node` and its descendants. */
function collectText(node: Node, lines: string[]): void {
  if (isTextNode(node)) {
    const text = node.value.trim();
    if (text !== '') {
      lines.push(text);
    }
    return;
  }
  if (!isParentNode(node) || isNonTextElement(node)) {
    return;
  }
  for (const child of node.childNodes) {
    collectText(child, lines);
  }
}

/**
 * Extracts the readable text of a parsed HTML document, one text node per
 * line. Each line is trimmed, and empty ones are dropped.
 *
 * Comments and the contents of `<script>` and `<style>` are left out. So is a
 * `<template>` body, which the parser stores outside the element's children.
 * Entities are already decoded by the parser.
 *
 * The caller supplies the document rather than the markup, so this module
 * needs no parser of its own. That matches
 * `BeautifulSoup.get_text(separator='\n', strip=True)`, which the ADK Python
 * tools use.
 */
export function htmlToText(document: DefaultTreeAdapterTypes.Document): string {
  const lines: string[] = [];
  collectText(document, lines);
  return lines.join('\n');
}
