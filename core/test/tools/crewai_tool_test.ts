/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CrewaiTool} from '@google/adk';
import {Type} from '@google/genai';
import {afterAll, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {logger} from '../../src/utils/logger.js';

// The alias warns when it is evaluated, so the spy has to exist before the
// first import of it. A static import would run before any spy.
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
const alias = await import('../../src/tools/crewai_tool.js');

afterAll(() => {
  vi.restoreAllMocks();
});

describe('tools/crewai_tool deprecated alias', () => {
  it('warns that the adapter moved', () => {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('@google/adk/tools/crewai_tool is deprecated'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Import it from "@google/adk" instead.'),
    );
  });

  it('re-exports the class the package exports', () => {
    expect(alias.CrewaiTool).toBe(CrewaiTool);
  });

  it('builds a working tool through the old import path', () => {
    const search = {
      name: 'search',
      description: 'Searches the web',
      argsSchema: z.object({query: z.string()}),
      run: ({query}: {query: string}) => `hit: ${query}`,
    };

    const adkTool = new alias.CrewaiTool({tool: search});

    expect(adkTool._getDeclaration()).toEqual({
      name: 'search',
      description: 'Searches the web',
      parameters: {
        type: Type.OBJECT,
        properties: {query: {type: Type.STRING}},
        required: ['query'],
      },
    });
  });

  it('re-exports the type guard the config path uses', () => {
    expect(alias.isCrewaiToolLike({run: () => 1})).toBe(true);
    expect(alias.isCrewaiToolLike(42)).toBe(false);
  });
});
