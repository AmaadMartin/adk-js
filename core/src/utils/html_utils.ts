/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {parse, type DefaultTreeAdapterTypes} from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;

/** Elements whose text is code, not prose, and is never part of the output. */
const CODE_ELEMENTS = new Set(['script', 'style']);

/** Separator between the text runs of two different nodes. */
const SEPARATOR = '\n';

/** Returns `true` when `node` holds character data rather than child nodes. */
function isTextNode(node: Node): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

/**
 * A `<template>` element parks its children in a separate document fragment,
 * so a plain `childNodes` walk would miss them.
 */
function isTemplate(node: Node): node is DefaultTreeAdapterTypes.Template {
  return node.nodeName === 'template';
}

/** Appends the text of `node` and its descendants to `runs`. */
function collectText(node: Node, runs: string[]): void {
  if (isTextNode(node)) {
    runs.push(node.value);
    return;
  }
  if (CODE_ELEMENTS.has(node.nodeName)) {
    return;
  }
  if (isTemplate(node)) {
    collectText(node.content, runs);
    return;
  }
  for (const child of 'childNodes' in node ? node.childNodes : []) {
    collectText(child, runs);
  }
}

/**
 * Extracts the readable text of an HTML document.
 *
 * Each text run is trimmed, empty runs are dropped, and the rest are joined
 * with a newline. Comments and the contents of `<script>` and `<style>` are
 * left out. Character references are decoded by the parser, so the result
 * carries the text a reader would see rather than the source markup.
 */
export function extractText(html: string): string {
  const runs: string[] = [];
  collectText(parse(html), runs);
  return runs
    .map((run) => run.trim())
    .filter(Boolean)
    .join(SEPARATOR);
}
