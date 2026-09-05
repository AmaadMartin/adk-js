/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool, ToolUnion} from '@google/genai';
import {canonicalJson} from './digest_utils.js';

/**
 * Returns true when the tool is a declarative genai `Tool` rather than a
 * `CallableTool`.
 *
 * A `CallableTool` resolves its declaration at call time, so only the
 * declarative arm can be serialized, hashed or sent to a service.
 */
export function isDeclarativeTool(tool: ToolUnion): tool is Tool {
  return !('callTool' in tool);
}

/** Keeps only the declarative tools of a genai tool list. */
export function declarativeTools(tools: ToolUnion[] | undefined): Tool[] {
  return (tools ?? []).filter(isDeclarativeTool);
}

/**
 * Orders two strings by code unit, so the result does not depend on a locale.
 * Unlike a two-way comparator, this reports equality, which a sort over
 * possibly-equal keys needs.
 */
function compareByCodeUnit(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Returns a copy of the tool with its function declarations sorted by name. */
function withSortedFunctionDeclarations(tool: Tool): Tool {
  if (!tool.functionDeclarations) {
    return tool;
  }
  return {
    ...tool,
    functionDeclarations: [...tool.functionDeclarations].sort((left, right) =>
      compareByCodeUnit(left.name ?? '', right.name ?? ''),
    ),
  };
}

/**
 * Returns the tools in a canonical order, so that a reordered tool list — or a
 * reordered `functionDeclarations` list within a tool — serializes identically.
 *
 * The caller's own arrays keep their order; the sorting happens on copies.
 *
 * @param tools The declarative tools to order.
 * @returns The same tools, ordered by their canonical JSON.
 */
export function canonicalizeTools(tools: Tool[]): Tool[] {
  return tools
    .map((tool) => {
      const sorted = withSortedFunctionDeclarations(tool);
      return {tool: sorted, key: canonicalJson(sorted)};
    })
    .sort((left, right) => compareByCodeUnit(left.key, right.key))
    .map(({tool}) => tool);
}
