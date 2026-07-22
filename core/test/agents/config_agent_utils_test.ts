import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  fromConfig,
  checkConfigForBlockedKeys,
  validateModuleReference,
  CodeConfigSchema,
  AgentRefConfigSchema,
  resolveFullyQualifiedName,
} from '../../src/agents/config_agent_utils.js';

vi.mock('fs/promises');

describe('config_agent_utils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('validateModuleReference', () => {
    it('blocks dangerous modules', () => {
      expect(() => validateModuleReference('child_process')).toThrow('Blocked module reference');
      expect(() => validateModuleReference('fs')).toThrow('Blocked module reference');
      expect(() => validateModuleReference('fs/promises')).toThrow('Blocked module reference');
      expect(() => validateModuleReference('os')).toThrow('Blocked module reference');
    });

    it('allows safe modules', () => {
      expect(() => validateModuleReference('lodash')).not.toThrow();
      expect(() => validateModuleReference('./my_local_module.js')).not.toThrow();
    });
  });

  describe('checkConfigForBlockedKeys', () => {
    it('blocks args key in object', () => {
      const badConfig = {name: 'agent', args: {foo: 'bar'}};
      expect(() => checkConfigForBlockedKeys(badConfig, 'bad.yaml')).toThrow(
        "Blocked key 'args' found in 'bad.yaml'.",
      );
    });

    it('checks nested arrays and objects', () => {
      const badConfig = {tools: [{name: 'tool'}, {type: 'xyz', args: {}}]};
      expect(() => checkConfigForBlockedKeys(badConfig, 'nested.yaml')).toThrow(
        "Blocked key 'args' found in 'nested.yaml'.",
      );
    });

    it('passes safe configurations', () => {
      const goodConfig = {name: 'agent', tools: [{name: 'tool'}]};
      expect(() => checkConfigForBlockedKeys(goodConfig, 'good.yaml')).not.toThrow();
    });
  });

  describe('AgentRefConfigSchema', () => {
    it('allows only one of code or configPath', () => {
      expect(() => AgentRefConfigSchema.parse({code: 'foo', configPath: 'bar'})).toThrow();
      expect(() => AgentRefConfigSchema.parse({})).toThrow();
      expect(AgentRefConfigSchema.parse({code: 'myCode'})).toEqual({code: 'myCode'});
      expect(AgentRefConfigSchema.parse({configPath: 'myPath'})).toEqual({configPath: 'myPath'});
    });
  });

  describe('resolveFullyQualifiedName', () => {
    it('resolves normal import and export', async () => {
      // Mocking dynamic import is hard in Jest/Vitest sometimes, but we can test paths
      // For now, let's test failure on blocked module
      await expect(resolveFullyQualifiedName('child_process', '/tmp')).rejects.toThrow('Blocked module reference');
      
      // We could try loading a known module inside our workspace, e.g. path
      const resolved = await resolveFullyQualifiedName('path.resolve', '/tmp');
      expect(resolved).toBe(path.resolve);
      
      const resolvedDefault = await resolveFullyQualifiedName('path', '/tmp');
      expect(resolvedDefault).toMatchObject({ resolve: path.resolve });
      
      // And local modules
      await expect(resolveFullyQualifiedName('./nonexistent_module.js.foo', '/tmp')).rejects.toThrow();
    });
  });

  describe('loadConfigFromPath', () => {
    it('throws if file does not exist', async () => {
      vi.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'));
      const {loadConfigFromPath} = await import('../../src/agents/config_agent_utils.js');
      await expect(loadConfigFromPath('/non-existent.yaml')).rejects.toThrow('FileNotFoundError');
    });

    it('throws if path is not a file', async () => {
      vi.spyOn(fs, 'access').mockResolvedValue(undefined);
      vi.spyOn(fs, 'stat').mockResolvedValue({isFile: () => false} as any);
      const {loadConfigFromPath} = await import('../../src/agents/config_agent_utils.js');
      await expect(loadConfigFromPath('/some-dir.yaml')).rejects.toThrow('FileNotFoundError: Config path is not a file');
    });

    it('throws on invalid yaml', async () => {
      vi.spyOn(fs, 'access').mockResolvedValue(undefined);
      vi.spyOn(fs, 'stat').mockResolvedValue({isFile: () => true} as any);
      vi.spyOn(fs, 'readFile').mockResolvedValue('invalid:\n  yaml: [unclosed');
      const {loadConfigFromPath} = await import('../../src/agents/config_agent_utils.js');
      await expect(loadConfigFromPath('/invalid.yaml')).rejects.toThrow('ValidationError');
    });
    
    it('loads and camelCases yaml', async () => {
      vi.spyOn(fs, 'access').mockResolvedValue(undefined);
      vi.spyOn(fs, 'stat').mockResolvedValue({isFile: () => true} as any);
      vi.spyOn(fs, 'readFile').mockResolvedValue('agent_class: "LlmAgent"\nname: "test_agent"\nfoo_bar: true');
      const {loadConfigFromPath} = await import('../../src/agents/config_agent_utils.js');
      const { data } = await loadConfigFromPath('/valid.yaml');
      expect(data).toHaveProperty('agentClass', 'LlmAgent');
      expect(data).toHaveProperty('name', 'test_agent');
      expect(data).toHaveProperty('fooBar', true); // camel case conversion worked
    });
  });

  describe('fromConfig and references', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('full flow via fromConfig resolving references', async () => {
      vi.spyOn(fs, 'access').mockResolvedValue(undefined);
      vi.spyOn(fs, 'stat').mockResolvedValue({isFile: () => true} as any);
      // Dummy logic to return appropriate file contents
      vi.spyOn(fs, 'readFile').mockImplementation(async (filePath) => {
        if (filePath.toString().includes('test_agent')) {
          return `
name: test_agent
sub_agents:
  - config_path: "sub.yaml"
before_agent_callback:
  name: "path.resolve"
after_agent_callback:
  - name: "path.resolve"
tools:
  - name: "path.resolve"
          `;
        } else if (filePath.toString().includes('sub.yaml')) {
          return 'name: sub_agent\nagent_class: "BaseAgent"';
        }
        return '';
      });

      // Let realpath just return original value to bypass traversal mock logic easily
      vi.spyOn(fs, 'realpath').mockImplementation(async (p: any) => p);

      const {fromConfig} = await import('../../src/agents/config_agent_utils.js');
      const agent = await fromConfig('/tmp/test_agent.yaml');
      expect(agent.name).toBe('test_agent');
      expect((agent as any).subAgents[0].name).toBe('sub_agent');
      expect((agent as any).beforeAgentCallback[0]).toBe(path.resolve);
      expect((agent as any).afterAgentCallback[0]).toBe(path.resolve);
      expect((agent as any).tools[0]).toBe(path.resolve);
    });

    it('rejects path traversal in AgentRefConfig configPath', async () => {
      const {resolveAgentReference} = await import('../../src/agents/config_agent_utils.js');
      // For path traversal check, realpath is used
      vi.spyOn(fs, 'realpath').mockImplementation(async (p: any) => p);
      await expect(resolveAgentReference({configPath: '../external.yaml'}, '/app/agents/test.yaml'))
        .rejects.toThrow('Path traversal detected');

      await expect(resolveAgentReference({configPath: '/absolute.yaml'}, '/app/agents/test.yaml'))
        .rejects.toThrow('Absolute paths are not allowed');
    });

    it('resolves AgentRefConfig with code', async () => {
      const {resolveAgentReference} = await import('../../src/agents/config_agent_utils.js');
      await expect(resolveAgentReference({code: 'nonexistent.agent'}, '/app/')).rejects.toThrow();
    });

    it('throws error for invalid CodeConfig', async () => {
      const {resolveCodeReference} = await import('../../src/agents/config_agent_utils.js');
      await expect(resolveCodeReference(null as any, '/tmp')).rejects.toThrow('Invalid CodeConfig.');
    });

    it('throws error if export not found in module', async () => {
      const {resolveFullyQualifiedName} = await import('../../src/agents/config_agent_utils.js');
      await expect(resolveFullyQualifiedName('path.nonExistentExport', '/tmp')).rejects.toThrow(/Export 'nonExistentExport' not found/);
    });

  });
});
