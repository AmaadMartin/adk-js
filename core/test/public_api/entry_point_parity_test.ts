/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import ts from 'typescript';
import {beforeAll, describe, expect, it} from 'vitest';

const CORE_ROOT = path.resolve(__dirname, '../..');

/** The entry points this suite compares, plus the module they must both reach. */
const ENTRY = {
  node: path.join(CORE_ROOT, 'src/index.ts'),
  web: path.join(CORE_ROOT, 'src/index_web.ts'),
  agentRegistryTypes: path.join(
    CORE_ROOT,
    'src/integrations/agent_registry/types.ts',
  ),
};

/** Budget (ms) for the hook below: it builds a program over all three graphs. */
const PROGRAM_TIMEOUT_MS = 30000;

/** Names a module exports, sorted, as the TypeScript checker resolves them. */
function exportNamesOf(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): string[] {
  return checker
    .getExportsOfModule(checker.getSymbolAtLocation(source)!)
    .map((symbol) => symbol.getName())
    .sort();
}

function missingFrom(names: string[], surface: string[]): string[] {
  return names.filter((name) => !surface.includes(name));
}

let exportNames: Record<keyof typeof ENTRY, string[]>;

describe('public entry points', () => {
  beforeAll(() => {
    const configPath = path.join(CORE_ROOT, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile).config;
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, CORE_ROOT);
    const program = ts.createProgram(Object.values(ENTRY), {
      ...parsed.options,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    exportNames = {
      node: exportNamesOf(checker, program.getSourceFile(ENTRY.node)!),
      web: exportNamesOf(checker, program.getSourceFile(ENTRY.web)!),
      agentRegistryTypes: exportNamesOf(
        checker,
        program.getSourceFile(ENTRY.agentRegistryTypes)!,
      ),
    };
  }, PROGRAM_TIMEOUT_MS);

  it('exposes every Agent Registry type from the browser entry point', () => {
    expect(exportNames.agentRegistryTypes.length).toBeGreaterThan(0);
    expect(
      missingFrom(exportNames.agentRegistryTypes, exportNames.web),
    ).toEqual([]);
  });

  it('exposes every Agent Registry type from the node entry point', () => {
    expect(
      missingFrom(exportNames.agentRegistryTypes, exportNames.node),
    ).toEqual([]);
  });

  it('keeps the browser surface a subset of the node surface', () => {
    expect(missingFrom(exportNames.web, exportNames.node)).toEqual([]);
  });
});
