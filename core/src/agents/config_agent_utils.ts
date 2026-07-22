import {z} from 'zod';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {toCamelCase} from '../utils/object_notation_utils.js';

export const BLOCKED_MODULES = new Set([
  'os',
  'child_process',
  'fs',
  'fs/promises',
  'vm',
  'v8',
  'worker_threads',
  'cluster',
  'net',
  'tls',
  'dgram',
  'http',
  'https',
  'http2',
  'repl',
  'inspector',
  'domain',
  'tty',
]);

const BLOCKED_YAML_KEYS = new Set(['args']);

export function checkConfigForBlockedKeys(node: unknown, filename: string): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      checkConfigForBlockedKeys(item, filename);
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (BLOCKED_YAML_KEYS.has(key)) {
        throw new Error(
          `Blocked key '${key}' found in '${filename}'. ` +
            `The '${key}' field is not allowed in agent configurations ` +
            'because it can execute arbitrary code.',
        );
      }
      checkConfigForBlockedKeys(value, filename);
    }
  }
}

export function validateModuleReference(modulePath: string): void {
  const topModule = modulePath.split('/')[0];
  if (BLOCKED_MODULES.has(modulePath) || BLOCKED_MODULES.has(topModule)) {
    throw new Error(
      `Blocked module reference: '${modulePath}'. Importing from this module ` +
        'is not allowed in agent configurations because it can execute arbitrary code.',
    );
  }
}

export const CodeConfigSchema = z
  .object({
    name: z.string(),
  })
  .strict();
export type CodeConfig = z.infer<typeof CodeConfigSchema>;

export const AgentRefConfigSchema = z
  .object({
    configPath: z.string().optional(),
    code: z.string().optional(),
  })
  .strict()
  .refine(
    (data) => {
      const codeProvided = data.code !== undefined;
      const configPathProvided = data.configPath !== undefined;
      return (codeProvided && !configPathProvided) || (!codeProvided && configPathProvided);
    },
    {message: 'Exactly one of `code` or `configPath` must be provided'},
  );
export type AgentRefConfig = z.infer<typeof AgentRefConfigSchema>;

export const BaseAgentConfigSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    agentClass: z.string().optional(),
  })
  .passthrough();

export const AgentConfigSchema = BaseAgentConfigSchema;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export async function resolveFullyQualifiedName(name: string, referencingConfigDir: string): Promise<any> {
  // In JS, module imports use '/' or paths. E.g. my-module, ./my-module.js
  // Let's resolve the module and optionally a named export.
  // Convention: `modulePath:exportName` or we can just try to see if name contains #
  // Or we just use `await import(name)` if it's the default, but often we want a named export.
  // We'll mimic Python's `my_module.my_class` by allowing `module-name.ClassName` or `./my-module.js.ClassName`.
  const lastDot = name.lastIndexOf('.');
  let modulePath = name;
  let exportName = '';
  
  if (lastDot !== -1 && !name.endsWith('.js') && !name.endsWith('.ts')) {
    modulePath = name.slice(0, lastDot);
    exportName = name.slice(lastDot + 1);
  }

  // Resolve absolute paths if it's relative
  if (modulePath.startsWith('.')) {
    modulePath = 'file://' + path.resolve(referencingConfigDir, modulePath);
  }

  validateModuleReference(modulePath);

  try {
    const module = await import(modulePath);
    if (exportName && exportName in module) {
      return module[exportName];
    } else if (exportName) {
      throw new Error(`Export '${exportName}' not found in module '${modulePath}'`);
    } else {
      return module.default || module;
    }
  } catch (error) {
    throw new Error(`Invalid fully qualified name: ${name}. ${error}`);
  }
}

export async function resolveCodeReference(
  codeConfig: CodeConfig,
  referencingConfigDir: string,
): Promise<any> {
  if (!codeConfig || !codeConfig.name) {
    throw new Error('Invalid CodeConfig.');
  }
  return await resolveFullyQualifiedName(codeConfig.name, referencingConfigDir);
}

export async function resolveAgentReference(
  refConfig: AgentRefConfig,
  referencingAgentConfigAbsPath: string,
): Promise<BaseAgent> {
  const agentDir = path.dirname(referencingAgentConfigAbsPath);
  if (refConfig.configPath) {
    if (path.isAbsolute(refConfig.configPath)) {
      throw new Error(
        `Absolute paths are not allowed in AgentRefConfig configPath: '${refConfig.configPath}'`,
      );
    }
    const resolvedPath = path.resolve(agentDir, refConfig.configPath);
    
    // Directory traversal check (like os.path.commonpath)
    const canonicalAgentDir = await fs.realpath(agentDir);
    const resolvedRealDir = path.dirname(await fs.realpath(path.dirname(resolvedPath)).catch(() => path.dirname(resolvedPath))); 
    // We check if resolvedPath starts with canonicalAgentDir
    const relative = path.relative(canonicalAgentDir, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Path traversal detected: configPath '${refConfig.configPath}' resolves outside the agent directory`,
      );
    }
    
    return await fromConfig(resolvedPath);
  } else if (refConfig.code) {
    return await resolveAgentCodeReference(refConfig.code, agentDir);
  } else {
    throw new Error("AgentRefConfig must have either 'code' or 'configPath'");
  }
}

async function resolveAgentCodeReference(code: string, agentDir: string): Promise<BaseAgent> {
  const obj = await resolveFullyQualifiedName(code, agentDir);
  
  if (typeof obj === 'function' && obj.prototype && 'name' in obj.prototype === false) {
     // Checking if it's an instance, not a constructor class
  }
  
  // Actually, we check if it's an instance of BaseAgent. 
  // We can't strictly use instanceof cross-realm sometimes, but let's try.
  if (!obj || typeof obj !== 'object' || !('name' in obj)) { // Simple duck typing for instance
     // If it's a model config?
  }
  
  return obj as BaseAgent;
}

export async function _resolveAgentClass(agentClassName: string, referencingConfigDir: string): Promise<new (...args: any[]) => BaseAgent> {
  const finalClassName = agentClassName || 'LlmAgent';
  let agentClass: any;
  if (!finalClassName.includes('.') && !finalClassName.includes('/')) {
    // If it's a built-in agent, import from '@google/adk'
    // But since we are IN @google/adk/core, we should import from our own exports
    agentClass = await import('../index.js').then(m => m[finalClassName as keyof typeof m]);
    if (!agentClass) {
        throw new Error(`Invalid agent class \`${finalClassName}\`. It must be a subclass of BaseAgent.`);
    }
  } else {
    agentClass = await resolveFullyQualifiedName(finalClassName, referencingConfigDir);
  }
  
  if (typeof agentClass !== 'function') {
    throw new Error(`Invalid agent class \`${finalClassName}\`. It must be a subclass of BaseAgent.`);
  }
  
  return agentClass as new (...args: any[]) => BaseAgent;
}

export async function loadConfigFromPath(configPath: string): Promise<{ data: AgentConfig, absPath: string }> {
  try {
    await fs.access(configPath);
  } catch (err) {
    throw new Error(`FileNotFoundError: Config file not found: ${configPath}`);
  }

  const absPath = path.resolve(configPath);
  const fileStats = await fs.stat(absPath);
  if (!fileStats.isFile()) {
    throw new Error(`FileNotFoundError: Config path is not a file: ${configPath}`);
  }

  const fileContent = await fs.readFile(absPath, 'utf8');
  let configData: unknown;
  try {
    configData = yaml.load(fileContent);
  } catch (err) {
    throw new Error(`ValidationError: Invalid YAML in ${configPath}`);
  }

  checkConfigForBlockedKeys(configData, configPath);
  
  const camelCasedData = toCamelCase(configData);

  try {
    const validatedData = AgentConfigSchema.parse(camelCasedData);
    return { data: validatedData, absPath };
  } catch (zodErr: any) {
    throw new Error(`ValidationError in ${configPath}: ${zodErr.message || JSON.stringify(zodErr)}`);
  }
}

export async function resolveRefsInConfig(config: any, referencingConfigDir: string): Promise<any> {
  // Resolve subAgents
  if (config.subAgents && Array.isArray(config.subAgents)) {
    config.subAgents = await Promise.all(
      config.subAgents.map((ref: any) => resolveAgentReference(ref, `${referencingConfigDir}/dummy.yaml`))
    );
  }

  // Resolve Callbacks
  const resolveCallback = async (cb: any) => {
    if (cb && cb.name && typeof cb.name === 'string') {
      return await resolveCodeReference(cb as CodeConfig, referencingConfigDir);
    }
    return cb;
  };

  if (config.beforeAgentCallback) {
    if (Array.isArray(config.beforeAgentCallback)) {
      config.beforeAgentCallback = await Promise.all(config.beforeAgentCallback.map(resolveCallback));
    } else {
      config.beforeAgentCallback = await resolveCallback(config.beforeAgentCallback);
    }
  }

  if (config.afterAgentCallback) {
    if (Array.isArray(config.afterAgentCallback)) {
      config.afterAgentCallback = await Promise.all(config.afterAgentCallback.map(resolveCallback));
    } else {
      config.afterAgentCallback = await resolveCallback(config.afterAgentCallback);
    }
  }

  if (config.tools && Array.isArray(config.tools)) {
    config.tools = await Promise.all(
      config.tools.map(async (toolRef: any) => {
        // Simple heuristic: if it has exactly "name" it's a CodeConfig (mimics python tool ref)
        if (toolRef && toolRef.name && typeof toolRef.name === 'string') {
          try {
            return await resolveCodeReference(toolRef as CodeConfig, referencingConfigDir);
          } catch (e) {
            // Ignore if it's not a FQN, might be just a normal tool config with a name
          }
        }
        return toolRef;
      })
    );
  }

  return config;
}

export async function fromConfig(configPath: string): Promise<BaseAgent> {
  const { data: rawConfig, absPath } = await loadConfigFromPath(configPath);
  const configDir = path.dirname(absPath);
  
  const agentConfig = await resolveRefsInConfig(rawConfig, configDir);
  const agentClassRef = agentConfig.agentClass || 'LlmAgent';
  const AgentClass = await _resolveAgentClass(agentClassRef, configDir);
  
  return new AgentClass(agentConfig);
}
