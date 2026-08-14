/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Project explorer for the Agent Builder Assistant.
 *
 * Ported from `cli/built_in_agents/tools/explore_project.py` in adk-python.
 */

import {Context, FunctionTool} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';

import {errorMessage} from '../../utils/error_utils.js';
import {
  resolveFilePath,
  rootDirectoryFromContext,
} from '../utils/resolve_root_directory.js';

/** How deep the reported directory tree goes before it is truncated. */
const MAX_TREE_DEPTH = 3;

/** Directory names left out of the reported tree, alongside dot entries. */
const IGNORED_TREE_ENTRIES = ['__pycache__', 'node_modules'];

/** Agent class assumed when a configuration does not name one. */
const DEFAULT_AGENT_CLASS = 'LlmAgent';

/** Basic facts about the project directory. */
export interface ProjectInfo {
  name: string;
  absolute_path: string;
  is_empty: boolean;
  total_files: number;
  total_directories: number;
  has_python_files: boolean;
  has_yaml_files: boolean;
  has_tools_directory: boolean;
  has_callbacks_directory: boolean;
}

/** A YAML agent configuration found in the project root. */
export interface ExistingConfig {
  filename: string;
  relative_path: string;
  size: number;
  is_valid_yaml: boolean;
  agent_name: string | null;
  agent_class: string | null;
  has_sub_agents: boolean;
  has_tools: boolean;
}

/** One node of the reported directory tree. */
export interface DirectoryNode {
  name?: string;
  type?: 'directory' | 'file';
  /** Path relative to the project root; `.` for the root itself. */
  path?: string;
  children?: DirectoryNode[];
  size?: number;
  error?: string;
  /** Set instead of the other fields once the depth cap is passed. */
  truncated?: boolean;
}

/** A directory the assistant may create, and what belongs in it. */
export interface DirectorySuggestion {
  path: string;
  exists: boolean;
  purpose: string;
  example_files: string[];
}

/** Recommended paths for the components the assistant may add. */
export interface PathSuggestions {
  root_agent_configs: string[];
  sub_agent_patterns: string[];
  directories: Record<string, DirectorySuggestion>;
}

/** ADK naming and organization conventions, returned verbatim to the model. */
export interface NamingConventions {
  agent_files: {
    format: string;
    examples: string[];
    location: string;
    avoid: string[];
  };
  agent_names: {format: string; examples: string[]; avoid: string[]};
  directory_structure: {recommended: Record<string, string>};
}

/** Result payload of the `explore_project` tool. */
export interface ExploreProjectResult {
  success: boolean;
  project_info?: ProjectInfo;
  existing_configs?: ExistingConfig[];
  directory_structure?: DirectoryNode;
  suggestions?: PathSuggestions;
  conventions?: NamingConventions;
  error?: string;
}

/** Arguments accepted by {@link exploreProject}: it takes none. */
const exploreProjectParameters = z.object({});

/**
 * Reports whether a thrown value is a filesystem permission error, the way
 * Python's `PermissionError` covers both `EACCES` and `EPERM`.
 */
export function isPermissionDenied(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return error.code === 'EACCES' || error.code === 'EPERM';
}

/**
 * Narrows a parsed YAML document to a mapping. A top-level list is valid YAML
 * but not an agent configuration, which is what the reference's
 * `isinstance(content, dict)` check means here.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Turns a failed exploration into the message reported to the model. */
export function describeExplorationFailure(error: unknown): string {
  return isPermissionDenied(error)
    ? 'Permission denied accessing project directory'
    : `Error exploring project: ${errorMessage(error)}`;
}

/** Counts the files and directories under `rootPath`, dot entries included. */
async function analyzeProjectInfo(rootPath: string): Promise<ProjectInfo> {
  const info: ProjectInfo = {
    name: path.basename(rootPath),
    absolute_path: rootPath,
    // Outside the try, as in the reference: an unreadable root is a failure of
    // the whole exploration, not a gap in the counts.
    is_empty: (await fs.readdir(rootPath)).length === 0,
    total_files: 0,
    total_directories: 0,
    has_python_files: false,
    has_yaml_files: false,
    has_tools_directory: false,
    has_callbacks_directory: false,
  };

  try {
    const pending = [rootPath];
    for (
      let directory = pending.pop();
      directory !== undefined;
      directory = pending.pop()
    ) {
      for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
        if (entry.isDirectory()) {
          info.total_directories++;
          if (directory === rootPath) {
            if (entry.name === 'tools') {
              info.has_tools_directory = true;
            } else if (entry.name === 'callbacks') {
              info.has_callbacks_directory = true;
            }
          }
          pending.push(path.join(directory, entry.name));
        } else {
          info.total_files++;
          switch (path.extname(entry.name).toLowerCase()) {
            case '.py':
              info.has_python_files = true;
              break;
            case '.yaml':
            case '.yml':
              info.has_yaml_files = true;
              break;
          }
        }
      }
    }
  } catch {
    // Report what the walk gathered before it failed, as the reference does.
  }

  return info;
}

/** Extracts the agent metadata of one YAML configuration file. */
async function analyzeConfigFile(
  configPath: string,
  rootPath: string,
): Promise<ExistingConfig> {
  const info: ExistingConfig = {
    filename: path.basename(configPath),
    relative_path: path.relative(rootPath, configPath),
    size: 0,
    is_valid_yaml: false,
    agent_name: null,
    agent_class: null,
    has_sub_agents: false,
    has_tools: false,
  };

  try {
    info.size = (await fs.stat(configPath)).size;
    const content = yaml.load(await fs.readFile(configPath, 'utf-8'));
    if (isRecord(content)) {
      info.is_valid_yaml = true;
      info.agent_name =
        typeof content['name'] === 'string' ? content['name'] : null;
      info.agent_class =
        typeof content['agent_class'] === 'string'
          ? content['agent_class']
          : DEFAULT_AGENT_CLASS;
      info.has_sub_agents = Boolean(content['sub_agents']);
      info.has_tools = Boolean(content['tools']);
    }
  } catch {
    // The file exists but could not be read or parsed; keep the defaults.
  }

  return info;
}

/** Lists the YAML configurations sitting directly in the project root. */
async function findExistingConfigs(
  rootPath: string,
): Promise<ExistingConfig[]> {
  const configs: ExistingConfig[] = [];

  try {
    const entries = await fs.readdir(rootPath, {withFileTypes: true});
    for (const extension of ['.yaml', '.yml']) {
      for (const entry of entries) {
        if (entry.isFile() && path.extname(entry.name) === extension) {
          configs.push(
            await analyzeConfigFile(path.join(rootPath, entry.name), rootPath),
          );
        }
      }
    }
    configs.sort((left, right) => (left.filename < right.filename ? -1 : 1));
  } catch {
    // Return whatever was scanned before the failure, as the reference does.
  }

  return configs;
}

/** Builds the tree of one directory or file, bounded by {@link MAX_TREE_DEPTH}. */
async function buildTree(
  entryPath: string,
  rootPath: string,
  depth: number,
): Promise<DirectoryNode> {
  if (depth > MAX_TREE_DEPTH) {
    return {truncated: true};
  }

  const stats = await fs.stat(entryPath).catch(() => undefined);
  const isDirectory = stats?.isDirectory() ?? false;
  const relative = path.relative(rootPath, entryPath);
  const node: DirectoryNode = {
    name: path.basename(entryPath),
    type: isDirectory ? 'directory' : 'file',
    // The reference reports the root as `.`, where `path.relative` gives ''.
    path: relative === '' ? '.' : relative,
  };

  if (!isDirectory) {
    node.size = stats?.size ?? 0;
    return node;
  }

  let names: string[];
  try {
    names = await fs.readdir(entryPath);
  } catch (error: unknown) {
    if (isPermissionDenied(error)) {
      node.error = 'Permission denied';
      return node;
    }
    throw error;
  }

  const children: DirectoryNode[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith('.') && !IGNORED_TREE_ENTRIES.includes(name)) {
      children.push(
        await buildTree(path.join(entryPath, name), rootPath, depth + 1),
      );
    }
  }
  node.children = children;
  return node;
}

/** Describes one directory the assistant may create under the project root. */
async function suggestDirectory(
  rootPath: string,
  name: string,
  purpose: string,
  exampleFiles: string[],
): Promise<DirectorySuggestion> {
  return {
    path: name,
    exists:
      (await fs.stat(path.join(rootPath, name)).catch(() => undefined)) !==
      undefined,
    purpose,
    example_files: exampleFiles,
  };
}

/** Suggests where new agent configurations and directories should go. */
async function generatePathSuggestions(
  rootPath: string,
  existingConfigs: ExistingConfig[],
): Promise<PathSuggestions> {
  const suggestRootAgent = !existingConfigs.some(
    (config) =>
      config.agent_class !== DEFAULT_AGENT_CLASS || !config.has_sub_agents,
  );

  const [tools, callbacks] = await Promise.all([
    suggestDirectory(rootPath, 'tools', 'Custom tool implementations', [
      'custom_email.py',
      'database_connector.py',
    ]),
    suggestDirectory(rootPath, 'callbacks', 'Custom callback functions', [
      'logging.py',
      'security.py',
    ]),
  ]);

  return {
    root_agent_configs: suggestRootAgent ? ['root_agent.yaml'] : [],
    sub_agent_patterns: [
      '{purpose}_agent.yaml',
      '{domain}_{action}_agent.yaml',
      '{workflow_step}_agent.yaml',
    ],
    directories: {tools, callbacks},
  };
}

/** The ADK naming conventions reported alongside the analysis. */
function namingConventions(): NamingConventions {
  return {
    agent_files: {
      format: 'snake_case with .yaml extension',
      examples: ['main_agent.yaml', 'email_processor.yaml'],
      location: 'Root directory of the project',
      avoid: ['camelCase.yaml', 'spaces in names.yaml', 'UPPERCASE.yaml'],
    },
    agent_names: {
      format: 'snake_case, descriptive, no spaces',
      examples: ['customer_service_coordinator', 'email_classifier'],
      avoid: ['Agent1', 'my agent', 'CustomerServiceAgent'],
    },
    directory_structure: {
      recommended: {
        root: 'All .yaml agent configuration files',
        'tools/': 'Custom tool implementations (.py files)',
        'callbacks/': 'Custom callback functions (.py files)',
      },
    },
  };
}

/**
 * Analyses the project directory and suggests where new agent files belong.
 *
 * The directory comes from the project root held in the session state; the
 * tool takes no arguments.
 *
 * @param context The tool context carrying the project root.
 * @return The analysis, or the reason it could not be produced.
 */
export async function exploreProject(
  context?: Context,
): Promise<ExploreProjectResult> {
  try {
    const rootPath = resolveFilePath('.', rootDirectoryFromContext(context));

    const stats = await fs.stat(rootPath).catch(() => undefined);
    if (stats === undefined) {
      return {
        success: false,
        error: `Project directory does not exist: ${rootPath}`,
      };
    }
    if (!stats.isDirectory()) {
      return {success: false, error: `Path is not a directory: ${rootPath}`};
    }

    const existingConfigs = await findExistingConfigs(rootPath);
    return {
      success: true,
      project_info: await analyzeProjectInfo(rootPath),
      existing_configs: existingConfigs,
      directory_structure: await buildTree(rootPath, rootPath, 0),
      suggestions: await generatePathSuggestions(rootPath, existingConfigs),
      conventions: namingConventions(),
    };
  } catch (error: unknown) {
    return {success: false, error: describeExplorationFailure(error)};
  }
}

/** The `explore_project` tool as the model sees it. */
export const exploreProjectTool = new FunctionTool({
  name: 'explore_project',
  description:
    'Analyse the structure of the project directory and suggest where new ' +
    'agent configurations, tools and callbacks belong. Takes no arguments.',
  parameters: exploreProjectParameters,
  execute: (_input, context) => exploreProject(context),
});
