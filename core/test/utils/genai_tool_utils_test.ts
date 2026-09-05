/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CallableTool, Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  canonicalizeTools,
  declarativeTools,
  isDeclarativeTool,
} from '../../src/utils/genai_tool_utils.js';

const ALPHA: Tool = {functionDeclarations: [{name: 'alpha', description: 'a'}]};
const BETA: Tool = {functionDeclarations: [{name: 'beta', description: 'b'}]};

function callableTool(): CallableTool {
  return {tool: async () => ALPHA, callTool: async () => []};
}

describe('isDeclarativeTool', () => {
  it('accepts a declarative tool', () => {
    expect(isDeclarativeTool(ALPHA)).toBe(true);
  });

  it('rejects a callable tool', () => {
    expect(isDeclarativeTool(callableTool())).toBe(false);
  });
});

describe('declarativeTools', () => {
  it('returns an empty list when there are no tools', () => {
    expect(declarativeTools(undefined)).toEqual([]);
  });

  it('drops the callable tools and keeps the order of the rest', () => {
    expect(declarativeTools([ALPHA, callableTool(), BETA])).toEqual([
      ALPHA,
      BETA,
    ]);
  });
});

describe('canonicalizeTools', () => {
  it('orders two tools the same way whichever way round they arrive', () => {
    expect(canonicalizeTools([ALPHA, BETA])).toEqual(
      canonicalizeTools([BETA, ALPHA]),
    );
  });

  it('orders the function declarations within a tool by name', () => {
    const forwards: Tool = {
      functionDeclarations: [{name: 'alpha'}, {name: 'beta'}],
    };
    const backwards: Tool = {
      functionDeclarations: [{name: 'beta'}, {name: 'alpha'}],
    };

    expect(canonicalizeTools([forwards])).toEqual(
      canonicalizeTools([backwards]),
    );
  });

  it('orders a function declaration that has no name', () => {
    const forwards: Tool = {
      functionDeclarations: [{description: 'no name'}, {name: 'a'}],
    };
    const backwards: Tool = {
      functionDeclarations: [{name: 'a'}, {description: 'no name'}],
    };

    expect(canonicalizeTools([forwards])).toEqual(
      canonicalizeTools([backwards]),
    );
  });

  it('keeps a tool that declares no functions', () => {
    const search: Tool = {googleSearch: {}};

    expect(canonicalizeTools([search])).toEqual([search]);
  });

  it('is stable when two tools are identical', () => {
    const duplicated = [ALPHA, ALPHA];

    expect(canonicalizeTools(duplicated)).toEqual([ALPHA, ALPHA]);
  });

  it('leaves the caller arrays untouched', () => {
    const declarations = [{name: 'beta'}, {name: 'alpha'}];
    const tool: Tool = {functionDeclarations: declarations};
    const tools = [BETA, tool];

    canonicalizeTools(tools);

    expect(declarations).toEqual([{name: 'beta'}, {name: 'alpha'}]);
    expect(tools).toEqual([BETA, tool]);
  });
});
