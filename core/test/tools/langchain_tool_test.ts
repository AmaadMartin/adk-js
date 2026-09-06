/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LangchainTool} from '@google/adk';
import {Type} from '@google/genai';
import {tool} from '@langchain/core/tools';
import {afterAll, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {logger} from '../../src/utils/logger.js';

// The alias warns when it is evaluated, so the spy has to exist before the
// first import of it. A static import would run before any spy.
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
const alias = await import('../../src/tools/langchain_tool.js');

afterAll(() => {
  vi.restoreAllMocks();
});

describe('tools/langchain_tool deprecated alias', () => {
  it('warns that the adapter moved', () => {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('@google/adk/tools/langchain_tool is deprecated'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Import it from "@google/adk" instead.'),
    );
  });

  it('re-exports the class the package exports', () => {
    expect(alias.LangchainTool).toBe(LangchainTool);
  });

  it('builds a working tool through the old import path', () => {
    const add = tool(({x, y}: {x: number; y: number}) => x + y, {
      name: 'add',
      description: 'Adds two numbers',
      schema: z.object({x: z.number(), y: z.number()}),
    });

    const adkTool = new alias.LangchainTool({tool: add});

    expect(adkTool._getDeclaration()).toEqual({
      name: 'add',
      description: 'Adds two numbers',
      parameters: {
        type: Type.OBJECT,
        properties: {x: {type: Type.NUMBER}, y: {type: Type.NUMBER}},
        required: ['x', 'y'],
      },
    });
  });

  it('re-exports the type guard the config path uses', () => {
    expect(alias.isLangchainToolLike({invoke: () => 1})).toBe(true);
    expect(alias.isLangchainToolLike(42)).toBe(false);
  });
});
