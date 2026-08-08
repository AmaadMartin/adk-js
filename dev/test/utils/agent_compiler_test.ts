/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterAll, beforeAll, describe, expect, it, Mock, vi} from 'vitest';

import {replaceDirnamePlugin} from '../../src/utils/agent_compiler.js';

/** The `replace-dirname` plugin registered on a stub esbuild build. */
interface PluginHarness {
  name: string;
  onLoad: Mock;
  load: (
    args: Pick<esbuild.OnLoadArgs, 'path'>,
  ) => Promise<esbuild.OnLoadResult | undefined>;
}

function setupPlugin(entryDirs: ReadonlyMap<string, string>): PluginHarness {
  const plugin = replaceDirnamePlugin(entryDirs);
  const build = {onLoad: vi.fn()};
  plugin.setup(build);

  return {
    name: plugin.name,
    onLoad: build.onLoad,
    load: build.onLoad.mock.calls[0][1],
  };
}

describe('replaceDirnamePlugin', () => {
  let tempAgentsDir: string;

  beforeAll(async () => {
    tempAgentsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-compiler-test'),
    );
  });

  afterAll(async () => {
    await fs.rm(tempAgentsDir, {recursive: true, force: true});
  });

  it.each([
    {
      name: 'replaces __dirname with original directory',
      content: `const dir = __dirname;\nconsole.log(__dirname);`,
      expected: (filePath: string, fileDir: string) => JSON.stringify(fileDir),
    },
    {
      name: 'replaces import.meta.url with file URL',
      content: 'const url = import.meta.url;',
      expected: (filePath: string) => pathToFileURL(filePath).href,
    },
    {
      name: 'replaces __filename with file path',
      content: 'const file = __filename;',
      expected: (filePath: string) => JSON.stringify(filePath),
    },
  ])('$name', async ({content, expected}) => {
    const filePath = path.join(tempAgentsDir, 'test_agent.ts');
    const fileDir = path.dirname(filePath);
    const plugin = setupPlugin(new Map([[filePath, fileDir]]));

    expect(plugin.name).toBe('replace-dirname');
    expect(plugin.onLoad).toHaveBeenCalledWith(
      {filter: /.*/},
      expect.any(Function),
    );

    await fs.writeFile(filePath, content);

    const result = await plugin.load({path: filePath});

    expect(result?.contents).toContain(expected(filePath, fileDir));
    expect(result?.loader).toBe('js');
  });

  it('does not replace tokens in strings', async () => {
    const filePath = path.join(tempAgentsDir, 'test_agent.ts');
    const fileDir = path.dirname(filePath);
    const plugin = setupPlugin(new Map([[filePath, fileDir]]));

    await fs.writeFile(
      filePath,
      `const str = "__dirname";\nconst code = __dirname;`,
    );

    const result = await plugin.load({path: filePath});

    expect(result?.contents).toContain('const str = "__dirname"');
    expect(result?.contents).toContain(JSON.stringify(fileDir));
    expect(result?.loader).toBe('js');
  });

  it('returns undefined for node_modules', async () => {
    const filePath = '/path/to/node_modules/some_pkg/index.js';
    const entryPath = path.join(tempAgentsDir, 'test_agent.ts');
    const plugin = setupPlugin(new Map([[entryPath, tempAgentsDir]]));

    const result = await plugin.load({path: filePath});

    expect(result).toBeUndefined();
  });

  it('gives each batched entry its own directory', async () => {
    const firstDir = await fs.mkdtemp(path.join(tempAgentsDir, 'batch-'));
    const secondDir = await fs.mkdtemp(path.join(tempAgentsDir, 'batch-'));
    const firstPath = path.join(firstDir, 'agent.ts');
    const secondPath = path.join(secondDir, 'agent.ts');
    await fs.writeFile(firstPath, 'const dir = __dirname;');
    await fs.writeFile(secondPath, 'const dir = __dirname;');

    const plugin = setupPlugin(
      new Map([
        [firstPath, firstDir],
        [secondPath, secondDir],
      ]),
    );

    const firstResult = await plugin.load({path: firstPath});
    const secondResult = await plugin.load({path: secondPath});

    expect(firstResult?.loader).toBe('js');
    expect(secondResult?.loader).toBe('js');
    expect(firstResult?.contents).toContain(JSON.stringify(firstDir));
    expect(firstResult?.contents).not.toContain(JSON.stringify(secondDir));
    expect(secondResult?.contents).toContain(JSON.stringify(secondDir));
    expect(secondResult?.contents).not.toContain(JSON.stringify(firstDir));
  });

  it.each([
    {name: 'uses js loader for non-ts files', fileName: 'test_agent.js'},
    {name: 'returns js loader for mts files', fileName: 'test_agent.mts'},
    {name: 'returns js loader for cts files', fileName: 'test_agent.cts'},
  ])('$name', async ({fileName}) => {
    const filePath = path.join(tempAgentsDir, fileName);
    const fileDir = path.dirname(filePath);
    const plugin = setupPlugin(new Map([[filePath, fileDir]]));

    await fs.writeFile(filePath, 'const dir = __dirname;');

    const result = await plugin.load({path: filePath});

    expect(result).toMatchObject({loader: 'js'});
  });
});
