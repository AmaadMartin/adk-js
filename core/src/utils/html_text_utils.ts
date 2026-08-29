/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DefaultTreeAdapterMap,
  DefaultTreeAdapterTypes,
  TreeAdapter,
} from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type HtmlTreeAdapter = TreeAdapter<DefaultTreeAdapterMap>;

/** Elements whose text is code rather than readable content. */
const NON_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * Deepest element nesting the parser will build.
 *
 * parse5 constructs the tree synchronously, and its cost grows with the square
 * of the nesting depth: 40_000 nested elements in 430 KiB of markup take about
 * 13 seconds on the main thread, and 10 MiB of them would take hours. A page
 * is attacker-influenced, so that is a denial of service against every other
 * task in the process. Real documents are two orders of magnitude shallower,
 * and browsers cap the depth for the same reason.
 */
const MAX_PARSE_DEPTH = 256;

/** Nodes to build between two checks of the deadline. */
const DEADLINE_CHECK_INTERVAL = 4096;

function isTextNode(node: Node): node is TextNode {
  return node.nodeName === '#text';
}

function isParentNode(node: Node): node is ParentNode {
  return 'childNodes' in node;
}

function isNonTextElement(node: ParentNode): boolean {
  return 'tagName' in node && NON_TEXT_ELEMENTS.has(node.tagName);
}

/**
 * Wraps a parse5 tree adapter so tree construction stays bounded.
 *
 * The adapter runs once per inserted node, which is the only place a caller
 * can interrupt a synchronous parse. Two limits apply: the nesting depth,
 * which is what makes the parse quadratic, and `expiresAt`, so the markup
 * shares the one absolute deadline the fetch already used. Both throw, and
 * `loadWebPage` reports a throw as its failure string.
 */
export function boundedTreeAdapter(
  base: HtmlTreeAdapter,
  expiresAt: number,
): HtmlTreeAdapter {
  const depths = new WeakMap<object, number>();
  // Starts at one so an already-expired deadline stops the parse immediately
  // rather than after the first full interval.
  let untilCheck = 1;

  function enter(parentNode: ParentNode, newNode: Node): void {
    if (--untilCheck <= 0) {
      untilCheck = DEADLINE_CHECK_INTERVAL;
      if (Date.now() > expiresAt) {
        throw new Error('Request timed out');
      }
    }
    const depth = (depths.get(parentNode) ?? 0) + 1;
    if (depth > MAX_PARSE_DEPTH) {
      throw new Error(`Markup nests deeper than ${MAX_PARSE_DEPTH} elements`);
    }
    depths.set(newNode, depth);
  }

  return {
    ...base,
    appendChild(parentNode, newNode) {
      enter(parentNode, newNode);
      base.appendChild(parentNode, newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      enter(parentNode, newNode);
      base.insertBefore(parentNode, newNode, referenceNode);
    },
  };
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
  // An explicit stack rather than recursion: the depth is the document's, and
  // a deep one would otherwise overflow the call stack.
  const pending: Node[] = [document];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isTextNode(node)) {
      const text = node.value.trim();
      if (text !== '') {
        lines.push(text);
      }
    } else if (isParentNode(node) && !isNonTextElement(node)) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        pending.push(node.childNodes[i]);
      }
    }
  }
  return lines.join('\n');
}
