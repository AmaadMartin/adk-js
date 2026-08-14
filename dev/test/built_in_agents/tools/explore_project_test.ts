/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  describeExplorationFailure,
  DirectoryNode,
  exploreProject,
  exploreProjectTool,
  isPermissionDenied,
} from '../../../src/built_in_agents/tools/explore_project.js';
import {createTestContext, useTempDirs, writeTree} from '../test_helpers.js';

/** Returns the child of `node` with the given name, failing when absent. */
function child(node: DirectoryNode | undefined, name: string): DirectoryNode {
  const found = node?.children?.find((entry) => entry.name === name);
  if (found === undefined) {
    expect.fail(`no child named ${name}`);
  }
  return found;
}

describe('exploreProject', () => {
  const tempDir = useTempDirs();

  it('describes an empty project and suggests a root agent config', async () => {
    const root = await tempDir();

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.project_info).toEqual({
      name: path.basename(root),
      absolute_path: root,
      is_empty: true,
      total_files: 0,
      total_directories: 0,
      has_python_files: false,
      has_yaml_files: false,
      has_tools_directory: false,
      has_callbacks_directory: false,
    });
    expect(result.existing_configs).toEqual([]);
    expect(result.suggestions?.root_agent_configs).toEqual(['root_agent.yaml']);
    expect(result.suggestions?.directories['tools'].exists).toBe(false);
    expect(result.conventions?.agent_files.location).toBe(
      'Root directory of the project',
    );
  });

  it('counts the files and directories of a populated project', async () => {
    const root = await tempDir();
    await writeTree(root, [
      'root_agent.yaml',
      'tools/search.py',
      'tools/deep/inner.txt',
      '.hidden.txt',
    ]);

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.project_info).toMatchObject({
      is_empty: false,
      total_files: 4,
      total_directories: 2,
      has_python_files: true,
      has_yaml_files: true,
      has_tools_directory: true,
      has_callbacks_directory: false,
    });
  });

  it('only flags tools and callbacks directly under the root', async () => {
    const root = await tempDir();
    await writeTree(root, ['pkg/tools/deep.py', 'callbacks/logging.py']);

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.project_info?.has_tools_directory).toBe(false);
    expect(result.project_info?.has_callbacks_directory).toBe(true);
    expect(result.suggestions?.directories['callbacks'].exists).toBe(true);
  });

  it('parses the YAML configurations in the root, sorted by filename', async () => {
    const root = await tempDir();
    await fs.writeFile(
      path.join(root, 'b_agent.yml'),
      'name: b\nagent_class: SequentialAgent\nsub_agents: [x]\ntools: [y]\n',
    );
    await fs.writeFile(path.join(root, 'a_agent.yaml'), 'name: a\n');
    await fs.writeFile(path.join(root, 'broken.yaml'), 'name: [unclosed\n');
    await fs.writeFile(path.join(root, 'list.yaml'), '- one\n- two\n');
    await fs.writeFile(path.join(root, 'numeric.yaml'), 'name: 123\n');

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.existing_configs?.map((config) => config.filename)).toEqual([
      'a_agent.yaml',
      'b_agent.yml',
      'broken.yaml',
      'list.yaml',
      'numeric.yaml',
    ]);
    expect(result.existing_configs?.[0]).toEqual({
      filename: 'a_agent.yaml',
      relative_path: 'a_agent.yaml',
      size: 8,
      is_valid_yaml: true,
      agent_name: 'a',
      agent_class: 'LlmAgent',
      has_sub_agents: false,
      has_tools: false,
    });
    expect(result.existing_configs?.[1]).toMatchObject({
      agent_class: 'SequentialAgent',
      has_sub_agents: true,
      has_tools: true,
    });
    // Neither an unparseable file nor a top-level list is an agent config.
    expect(result.existing_configs?.[2]).toMatchObject({
      is_valid_yaml: false,
      agent_name: null,
      agent_class: null,
    });
    expect(result.existing_configs?.[3]).toMatchObject({
      is_valid_yaml: false,
      agent_class: null,
    });
    // A non-string name is not an agent name.
    expect(result.existing_configs?.[4]).toMatchObject({
      is_valid_yaml: true,
      agent_name: null,
    });
  });

  it('suppresses the root agent suggestion once a plain agent config exists', async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, 'root_agent.yaml'), 'name: demo\n');

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.suggestions?.root_agent_configs).toEqual([]);
  });

  it('keeps the suggestion when every config is an LlmAgent with sub agents', async () => {
    const root = await tempDir();
    await fs.writeFile(
      path.join(root, 'parent.yaml'),
      'name: parent\nagent_class: LlmAgent\nsub_agents: [child]\n',
    );

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.suggestions?.root_agent_configs).toEqual(['root_agent.yaml']);
  });

  it('reports the root of the tree as "." and records file sizes', async () => {
    const root = await tempDir();
    await writeTree(root, ['a.txt']);

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(result.directory_structure).toMatchObject({
      name: path.basename(root),
      type: 'directory',
      path: '.',
    });
    expect(child(result.directory_structure, 'a.txt')).toEqual({
      name: 'a.txt',
      type: 'file',
      path: 'a.txt',
      size: 1,
    });
  });

  it('leaves hidden entries, __pycache__ and node_modules out of the tree', async () => {
    const root = await tempDir();
    await writeTree(root, [
      '.hidden/x.txt',
      '__pycache__/x.pyc',
      'node_modules/pkg/index.js',
      'kept.txt',
    ]);

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    expect(
      result.directory_structure?.children?.map((entry) => entry.name),
    ).toEqual(['kept.txt']);
  });

  it('truncates the tree past the depth cap', async () => {
    const root = await tempDir();
    await writeTree(root, ['a/b/c/d.txt']);

    const result = await exploreProject(
      createTestContext({root_directory: root}),
    );

    const c = child(child(child(result.directory_structure, 'a'), 'b'), 'c');
    expect(c.children).toEqual([{truncated: true}]);
  });

  it('reports a missing project directory', async () => {
    const root = await tempDir();
    const missing = path.join(root, 'nope');

    const result = await exploreProject(
      createTestContext({root_directory: missing}),
    );

    expect(result).toEqual({
      success: false,
      error: `Project directory does not exist: ${missing}`,
    });
  });

  it('reports a project path that is a file', async () => {
    const root = await tempDir();
    const file = path.join(root, 'agent.yaml');
    await fs.writeFile(file, 'name: demo');

    const result = await exploreProject(
      createTestContext({root_directory: file}),
    );

    expect(result).toEqual({
      success: false,
      error: `Path is not a directory: ${file}`,
    });
  });
});

describe('isPermissionDenied', () => {
  it.each([['EACCES'], ['EPERM']])('accepts a %s error', (code) => {
    expect(isPermissionDenied(Object.assign(new Error('nope'), {code}))).toBe(
      true,
    );
  });

  it.each([
    [Object.assign(new Error('nope'), {code: 'ENOENT'})],
    [new Error('plain')],
    ['a string'],
    [null],
  ])('rejects %j', (error) => {
    expect(isPermissionDenied(error)).toBe(false);
  });
});

describe('describeExplorationFailure', () => {
  it('names a permission failure without leaking the path', () => {
    expect(
      describeExplorationFailure(
        Object.assign(new Error("EACCES: permission denied, scandir '/x'"), {
          code: 'EACCES',
        }),
      ),
    ).toBe('Permission denied accessing project directory');
  });

  it('reports any other failure with its message', () => {
    expect(describeExplorationFailure(new Error('disk on fire'))).toBe(
      'Error exploring project: disk on fire',
    );
  });
});

describe('exploreProjectTool', () => {
  const tempDir = useTempDirs();

  it('explores through the tool wrapper', async () => {
    const root = await tempDir();

    const result = await exploreProjectTool.runAsync({
      args: {},
      toolContext: createTestContext({root_directory: root}),
    });

    expect(result).toMatchObject({success: true});
  });
});
