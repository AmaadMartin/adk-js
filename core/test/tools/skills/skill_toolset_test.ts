/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  BaseTool,
  BaseToolset,
  Context,
  InvocationContext,
  LlmRequest,
  ReadonlyContext,
  SearchSkillsTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {getSkillResourceFiles} from '../../../src/tools/skill/run_skill_script_tool.js';

describe('skill_toolset', () => {
  const mockSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    instructions: 'Test instructions',
    resources: {
      references: {
        'doc.md': 'Doc content',
      },
      assets: {
        'image.png': Buffer.from('fake image data'),
      },
      scripts: {
        'run.sh': {src: 'echo hello'},
      },
    },
  };

  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
    });
  }

  describe('SkillToolset', () => {
    it('provides default tools', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toContain('list_skills');
      expect(tools.map((t) => t.name)).toContain('load_skill');
      expect(tools.map((t) => t.name)).toContain('load_skill_resource');
    });

    it('returns default tools only when no context provided', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tools = await toolset.getTools();
      expect(tools.length).toBe(5);
      expect(tools.map((t) => t.name)).toEqual([
        'list_skills',
        'load_skill',
        'load_skill_resource',
        'run_skill_script',
        'run_skill_inline_script',
      ]);
    });

    it('returns default tools only when no skills activated', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const context = createMockContext();
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(5);
    });

    it('appends instructions to LLM request', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await toolset.processLlmRequest(createMockContext(), llmRequest);

      expect(llmRequest.config?.systemInstruction).toContain(
        "You can use specialized 'skills'",
      );
      expect(llmRequest.config?.systemInstruction).toContain(
        '<name>test-skill</name>',
      );
    });

    it('resolves additional tools when skill is activated', async () => {
      class DummyTool extends BaseTool {
        constructor() {
          super({name: 'dummy_tool', description: 'dummy'});
        }
        _getDeclaration() {
          return {name: 'dummy_tool', description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }
      const dummyTool = new DummyTool();

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['dummy_tool'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [dummyTool],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      const tools = await toolset.getTools(context);
      expect(tools.map((t) => t.name)).toContain('dummy_tool');
    });

    it('throws error when duplicate BaseTool names are provided in additionalTools', async () => {
      class DummyTool extends BaseTool {
        constructor(name: string) {
          super({name, description: 'dummy'});
        }
        _getDeclaration() {
          return {name: this.name, description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }
      const tool1 = new DummyTool('duplicate_tool');
      const tool2 = new DummyTool('duplicate_tool');

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['duplicate_tool'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [tool1, tool2],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      await expect(toolset.getTools(context)).rejects.toThrow(
        'Duplicate tool name: duplicate_tool',
      );
    });

    it('throws error when duplicate tool names are detected via BaseToolset in additionalTools', async () => {
      class DummyTool extends BaseTool {
        constructor(name: string) {
          super({name, description: 'dummy'});
        }
        _getDeclaration() {
          return {name: this.name, description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }

      class DummyToolset extends BaseToolset {
        constructor(private mockTools: BaseTool[]) {
          super([]);
        }
        override async getTools() {
          return this.mockTools;
        }
        override async close() {}
      }

      const tool1 = new DummyTool('shared_name');
      const tool2 = new DummyTool('shared_name');
      const customToolset = new DummyToolset([tool2]);

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['shared_name'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [tool1, customToolset],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      await expect(toolset.getTools(context)).rejects.toThrow(
        'Duplicate tool name: shared_name',
      );
    });

    it('caches resolved tools and avoids recalculating candidateTools', async () => {
      class DummyTool extends BaseTool {
        constructor() {
          super({name: 'cached_tool', description: 'dummy'});
        }
        _getDeclaration() {
          return {name: 'cached_tool', description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }

      const mockInnerGetTools = vi.fn().mockResolvedValue([new DummyTool()]);

      class SpyToolset extends BaseToolset {
        constructor() {
          super([]);
        }
        override getTools = mockInnerGetTools;
        override async close() {}
      }

      const spyToolset = new SpyToolset();

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['cached_tool'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [spyToolset],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      const tools1 = await toolset.getTools(context);
      expect(tools1.map((t) => t.name)).toContain('cached_tool');
      expect(mockInnerGetTools).toHaveBeenCalledTimes(1);

      const tools2 = await toolset.getTools(context);
      expect(tools2.map((t) => t.name)).toContain('cached_tool');
      expect(mockInnerGetTools).toHaveBeenCalledTimes(1);
    });

    it('initializes and provides SearchSkillsTool when registry is present', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn().mockReturnValue('custom description'),
      };
      const toolset = new SkillToolset([mockSkill], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toContain('search_skills');
      const searchTool = tools.find((t) => t.name === 'search_skills')!;
      expect(searchTool.description).toBe('custom description');
    });

    it('appends search registry instructions to LLM request when registry is present', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([mockSkill], {
        registry: mockRegistry,
      });
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await toolset.processLlmRequest(createMockContext(), llmRequest);

      expect(llmRequest.config?.systemInstruction).toContain(
        'use the `search_skills` tool to discover additional skills',
      );
    });

    it('resolves remote skills from registry and caches them', async () => {
      const remoteSkill: Skill = {
        frontmatter: {
          name: 'remote-skill',
          description: 'A remote skill description',
        },
        instructions: 'Remote instructions',
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });

      const skill1 = await toolset.getOrFetchSkill('remote-skill', 'turn-1');
      expect(skill1).toEqual(remoteSkill);
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(1);

      // Subsequent fetch in same turn uses cache
      const skill2 = await toolset.getOrFetchSkill('remote-skill', 'turn-1');
      expect(skill2).toEqual(remoteSkill);
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(1);

      // Fetch in different turn queries registry again
      const skill3 = await toolset.getOrFetchSkill('remote-skill', 'turn-2');
      expect(skill3).toEqual(remoteSkill);
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(2);
    });

    it('evicts oldest turn cache entry when maxCacheTurns is reached', async () => {
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(mockSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });

      // Populate cache up to maxCacheTurns (16)
      for (let i = 0; i < 16; i++) {
        await toolset.getOrFetchSkill('test-skill', `turn-${i}`);
      }
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(16);

      // Now fetch with turn-16 (should evict turn-0)
      await toolset.getOrFetchSkill('test-skill', 'turn-16');
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(17);

      // Querying turn-0 again should hit the registry instead of cache
      await toolset.getOrFetchSkill('test-skill', 'turn-0');
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(18);
    });

    it('deletes promise from cache and rethrows if registry.getSkill rejects', async () => {
      const mockRegistry = {
        getSkill: vi
          .fn()
          .mockRejectedValue(new Error('Registry lookup failed')),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });

      await expect(
        toolset.getOrFetchSkill('remote-skill', 'turn-1'),
      ).rejects.toThrow('Registry lookup failed');

      // Second attempt should hit the registry again since the first attempt was evicted
      await expect(
        toolset.getOrFetchSkill('remote-skill', 'turn-1'),
      ).rejects.toThrow('Registry lookup failed');
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(2);
    });
  });

  describe('SearchSkillsTool', () => {
    it('throws if query argument is missing', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const searchTool = tools.find((t) => t.name === 'search_skills')!;

      const result = await searchTool.runAsync({
        args: {},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Argument 'query' is required.",
        error_code: 'INVALID_ARGUMENTS',
      });
    });

    it('searches remote skills and filters out local duplicates', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn().mockResolvedValue([
          {name: 'local-skill', description: 'desc'},
          {name: 'another-remote-skill', description: 'desc2'},
        ]),
        searchToolDescription: vi.fn(),
      };
      const localSkill: Skill = {
        frontmatter: {
          name: 'local-skill',
          description: 'Local desc',
        },
        instructions: 'Local instructions',
      };
      const toolset = new SkillToolset([localSkill], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const searchTool = tools.find((t) => t.name === 'search_skills')!;

      const result = await searchTool.runAsync({
        args: {query: 'test'},
        toolContext: createMockContext(),
      });

      expect(result).toEqual([
        {name: 'another-remote-skill', description: 'desc2'},
      ]);
    });

    it('returns error if search fails', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn().mockRejectedValue(new Error('API Error')),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const searchTool = tools.find((t) => t.name === 'search_skills')!;

      const result = await searchTool.runAsync({
        args: {query: 'test'},
        toolContext: createMockContext(),
      });

      expect(result).toEqual({
        error: 'Failed to search skills from registry: Error: API Error',
        error_code: 'REGISTRY_ERROR',
      });
    });
  });

  describe('tools fetching from registry', () => {
    it('LoadSkillTool fetches skill from registry if not local', async () => {
      const remoteSkill: Skill = {
        frontmatter: {
          name: 'remote-skill',
          description: 'A remote skill',
        },
        instructions: 'Remote instructions',
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const loadTool = tools.find((t) => t.name === 'load_skill')!;

      const context = createMockContext();
      const result = (await loadTool.runAsync({
        args: {name: 'remote-skill'},
        toolContext: context,
      })) as {skill_name: string; instructions: string};

      expect(result.skill_name).toBe('remote-skill');
      expect(result.instructions).toBe('Remote instructions');
      expect(mockRegistry.getSkill).toHaveBeenCalledWith({
        name: 'remote-skill',
      });

      // Check skill was activated in state
      const stateKey = `_adk_activated_skill_test-agent`;
      expect(context.state.get(stateKey)).toContain('remote-skill');
    });

    it('LoadSkillTool propagates registry errors', async () => {
      const mockRegistry = {
        getSkill: vi.fn().mockRejectedValue(new Error('API Failure')),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const loadTool = tools.find((t) => t.name === 'load_skill')!;

      const result = await loadTool.runAsync({
        args: {name: 'remote-skill'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error:
          "Failed to fetch skill 'remote-skill' from registry: Error: API Failure",
        error_code: 'REGISTRY_ERROR',
      });
    });

    it('LoadSkillResourceTool loads from registry skill', async () => {
      const remoteSkill: Skill = {
        frontmatter: {
          name: 'remote-skill',
          description: 'A remote skill',
        },
        instructions: 'Remote instructions',
        resources: {
          references: {
            'doc.md': 'Remote doc content',
          },
        },
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const resourceTool = tools.find((t) => t.name === 'load_skill_resource')!;

      const result = await resourceTool.runAsync({
        args: {skill_name: 'remote-skill', path: 'references/doc.md'},
        toolContext: createMockContext(),
      });

      expect(result).toEqual({
        skill_name: 'remote-skill',
        path: 'references/doc.md',
        content: 'Remote doc content',
      });
    });

    it('LoadSkillResourceTool propagates registry errors', async () => {
      const mockRegistry = {
        getSkill: vi.fn().mockRejectedValue(new Error('API Failure')),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const resourceTool = tools.find((t) => t.name === 'load_skill_resource')!;

      const result = await resourceTool.runAsync({
        args: {skill_name: 'remote-skill', path: 'references/doc.md'},
        toolContext: createMockContext(),
      });

      expect(result).toEqual({
        error:
          "Failed to fetch skill 'remote-skill' from registry: Error: API Failure",
        error_code: 'REGISTRY_ERROR',
      });
    });

    it('RunSkillScriptTool fetches skill from registry if not local', async () => {
      const remoteSkill: Skill = {
        frontmatter: {
          name: 'remote-skill',
          description: 'A remote skill',
        },
        instructions: 'Remote instructions',
        resources: {
          scripts: {
            'run.sh': {src: 'echo 123'},
          },
        },
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const runScriptTool = tools.find((t) => t.name === 'run_skill_script')!;

      const result = await runScriptTool.runAsync({
        args: {skill_name: 'remote-skill', script_path: 'scripts/run.sh'},
        toolContext: createMockContext(),
      });

      // Should fetch from registry, but then fail because code executor is not configured
      expect(result).toEqual({
        error: 'No code executor configured.',
        errorCode: 'NO_CODE_EXECUTOR',
      });
      expect(mockRegistry.getSkill).toHaveBeenCalledWith({
        name: 'remote-skill',
      });
    });

    it('RunSkillScriptTool propagates registry errors', async () => {
      const mockRegistry = {
        getSkill: vi.fn().mockRejectedValue(new Error('API Failure')),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {
        registry: mockRegistry,
      });
      const tools = await toolset.getTools();
      const runScriptTool = tools.find((t) => t.name === 'run_skill_script')!;

      const result = await runScriptTool.runAsync({
        args: {skill_name: 'remote-skill', script_path: 'scripts/run.sh'},
        toolContext: createMockContext(),
      });

      expect(result).toEqual({
        error:
          "Failed to fetch skill 'remote-skill' from registry: Error: API Failure",
        errorCode: 'REGISTRY_ERROR',
      });
    });
  });

  describe('SearchSkillsTool additional coverage', () => {
    it('throws if constructed without a registry', () => {
      const toolset = new SkillToolset([]);
      expect(() => new SearchSkillsTool(toolset)).toThrow(
        'SearchSkillsTool requires a configured skill registry.',
      );
    });

    it('returns function declaration', () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const searchTool = new SearchSkillsTool(toolset);
      const decl = searchTool._getDeclaration();
      expect(decl.name).toBe('search_skills');
      expect(decl.parameters?.required).toContain('query');
    });

    it('returns error if registry is removed or missing at run time', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const searchTool = new SearchSkillsTool(toolset);
      // Force registry to be undefined
      Object.defineProperty(toolset, 'registry', {value: undefined});

      const result = await searchTool.runAsync({
        args: {query: 'test'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: 'SearchSkillsTool requires a configured skill registry.',
        error_code: 'REGISTRY_ERROR',
      });
    });
  });

  describe('SkillToolset additional coverage', () => {
    it('accepts skills as a Record in the constructor', () => {
      const toolset = new SkillToolset({
        'test-skill': mockSkill,
      });
      expect(toolset.getSkill('test-skill')).toEqual(mockSkill);
    });

    it('clears fetchedSkillCache on close()', async () => {
      const remoteSkill: Skill = {
        frontmatter: {name: 'remote-skill', description: 'desc'},
        instructions: 'Remote instructions',
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      await toolset.getOrFetchSkill('remote-skill', 'turn-1');

      await toolset.close();
      // Cache should be cleared. Next call in turn-1 should trigger registry getSkill again.
      await toolset.getOrFetchSkill('remote-skill', 'turn-1');
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(2);
    });

    it('returns early in getOrFetchSkill if registry is not configured', async () => {
      const toolset = new SkillToolset([]);
      const skill = await toolset.getOrFetchSkill('non-existent');
      expect(skill).toBeUndefined();
    });

    it('handles activated skills with no additional tools', async () => {
      const skillNoTools: Skill = {
        frontmatter: {name: 'skill-no-tools', description: 'desc'},
        instructions: 'Instructions',
      };
      const toolset = new SkillToolset([skillNoTools]);
      const mockState = {
        get: vi.fn().mockReturnValue(['skill-no-tools']),
      };
      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(5); // should resolve to default tools only
    });
  });

  describe('declarations and edge cases for other tools', () => {
    it('LoadSkillTool returns declaration', () => {
      const toolset = new SkillToolset([]);
      const loadTool = toolsfind(toolset, 'load_skill');
      const decl = loadTool._getDeclaration();
      expect(decl.name).toBe('load_skill');
      expect(decl.parameters?.required).toContain('name');
    });

    it('LoadSkillResourceTool returns declaration', () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const decl = resourceTool._getDeclaration();
      expect(decl.name).toBe('load_skill_resource');
      expect(decl.parameters?.required).toContain('path');
    });

    it('RunSkillScriptTool returns declaration', () => {
      const toolset = new SkillToolset([]);
      const runScriptTool = toolsfind(toolset, 'run_skill_script');
      const decl = runScriptTool._getDeclaration();
      expect(decl.name).toBe('run_skill_script');
      expect(decl.parameters?.required).toContain('script_path');
    });

    it('LoadSkillResourceTool processLlmRequest early exits if lastContent role is not user', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const llmRequest: LlmRequest = {
        contents: [{role: 'model', parts: []}],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await resourceTool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });
      expect(llmRequest.contents.length).toBe(1);
    });

    it('LoadSkillResourceTool processLlmRequest handles binary path in references', async () => {
      const mockSkillWithBinaryRef: Skill = {
        frontmatter: {name: 'test-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          references: {
            'doc.png': Buffer.from('binary ref data'),
          },
        },
      };
      const toolset = new SkillToolset([mockSkillWithBinaryRef]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');

      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: {
                    skill_name: 'test-skill',
                    path: 'references/doc.png',
                    status:
                      'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                  },
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await resourceTool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });

      expect(llmRequest.contents.length).toBe(2);
      expect(llmRequest.contents[1].role).toBe('user');
      expect(llmRequest.contents[1].parts?.[1]?.inlineData?.data).toBe(
        Buffer.from('binary ref data').toString('base64'),
      );
    });

    it('LoadSkillResourceTool processLlmRequest handles binary path in references for registry-fetched skill', async () => {
      const remoteSkill: Skill = {
        frontmatter: {name: 'remote-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          references: {
            'doc.png': Buffer.from('remote binary ref data'),
          },
        },
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
        searchToolDescription: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const resourceTool = toolsfind(toolset, 'load_skill_resource');

      // Fetch the skill first to populate the cache
      const toolContext = createMockContext();
      await toolset.getOrFetchSkill('remote-skill', toolContext.invocationId);

      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: {
                    skill_name: 'remote-skill',
                    path: 'references/doc.png',
                    status:
                      'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                  },
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await resourceTool.processLlmRequest({
        toolContext,
        llmRequest,
      });

      expect(llmRequest.contents.length).toBe(2);
      expect(llmRequest.contents[1].role).toBe('user');
      expect(llmRequest.contents[1].parts?.[1]?.inlineData?.data).toBe(
        Buffer.from('remote binary ref data').toString('base64'),
      );
    });

    it('LoadSkillTool returns error if name is missing', async () => {
      const toolset = new SkillToolset([]);
      const loadTool = toolsfind(toolset, 'load_skill');
      const result = await loadTool.runAsync({
        args: {},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: 'Skill name is required.',
        error_code: 'MISSING_SKILL_NAME',
      });
    });

    it('LoadSkillTool returns error if skill is not found', async () => {
      const toolset = new SkillToolset([]);
      const loadTool = toolsfind(toolset, 'load_skill');
      const result = await loadTool.runAsync({
        args: {name: 'non-existent'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Skill 'non-existent' not found.",
        error_code: 'SKILL_NOT_FOUND',
      });
    });

    it('LoadSkillResourceTool returns error if skill is not found', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const result = await resourceTool.runAsync({
        args: {skill_name: 'non-existent', path: 'references/doc.md'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Skill 'non-existent' not found.",
        error_code: 'SKILL_NOT_FOUND',
      });
    });

    it('LoadSkillResourceTool processLlmRequest early exits if lastContent has no parts', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const llmRequest: LlmRequest = {
        contents: [{role: 'user'} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await resourceTool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });
      expect(llmRequest.contents.length).toBe(1);
    });

    it('LoadSkillResourceTool returns error if skill name is missing', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const result = await resourceTool.runAsync({
        args: {path: 'references/doc.md'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: 'Skill name is required.',
        error_code: 'MISSING_SKILL_NAME',
      });
    });

    it('LoadSkillResourceTool returns error if resource path is missing', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const result = await resourceTool.runAsync({
        args: {skill_name: 'test-skill'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: 'Resource path is required.',
        error_code: 'MISSING_RESOURCE_PATH',
      });
    });

    it('LoadSkillResourceTool processLlmRequest early exits if contents is empty or undefined', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await resourceTool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });
      expect(llmRequest.contents.length).toBe(0);
    });

    it('RunSkillScriptTool returns error if script path is missing', async () => {
      const toolset = new SkillToolset([]);
      const runScriptTool = toolsfind(toolset, 'run_skill_script');
      const result = await runScriptTool.runAsync({
        args: {skill_name: 'test-skill'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: 'Script path is required.',
        errorCode: 'MISSING_SCRIPT_PATH',
      });
    });

    it('RunSkillScriptTool returns error if wrapper language is unsupported', async () => {
      const skill: Skill = {
        frontmatter: {name: 'test-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          scripts: {
            'run.rb': {src: 'puts 123'},
          },
        },
      };
      const mockCodeExecutor = {
        executeCode: vi.fn(),
      };
      const toolset = new SkillToolset([skill], {
        codeExecutor: mockCodeExecutor as unknown as BaseCodeExecutor,
      });
      const runScriptTool = toolsfind(toolset, 'run_skill_script');
      const result = await runScriptTool.runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/run.rb'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error:
          "Failed to execute script 'scripts/run.rb': Unsupported wrapper language: unspecified",
        errorCode: 'EXECUTION_ERROR',
      });
    });

    it('RunSkillScriptTool getSkillResourceFiles filters undefined content', () => {
      const skillWithUndefContent = {
        frontmatter: {name: 'test-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          references: {
            'doc.md': undefined,
          },
        },
      } as unknown as Skill;
      const files = getSkillResourceFiles(skillWithUndefContent);
      expect(files.length).toBe(0);
    });

    it('LoadSkillResourceTool handles skill with no resources', async () => {
      const skillNoRes: Skill = {
        frontmatter: {name: 'no-res', description: 'desc'},
        instructions: 'inst',
      };
      const toolset = new SkillToolset([skillNoRes]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const result = await resourceTool.runAsync({
        args: {skill_name: 'no-res', path: 'references/doc.md'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Resource 'references/doc.md' not found in skill 'no-res'.",
        error_code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('LoadSkillResourceTool processLlmRequest handles null response', async () => {
      const toolset = new SkillToolset([]);
      const resourceTool = toolsfind(toolset, 'load_skill_resource');
      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: null as unknown as Record<string, unknown>,
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await resourceTool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });
      // Should exit without throwing or modifying
      expect(llmRequest.contents.length).toBe(1);
    });

    it('RunSkillScriptTool generates PowerShell wrapper wrapper code', async () => {
      const skill: Skill = {
        frontmatter: {name: 'test-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          scripts: {
            'run.ps1': {src: 'echo 123'},
          },
        },
      };
      const mockCodeExecutor = {
        executeCode: vi
          .fn()
          .mockResolvedValue({stdout: '', stderr: '', outputFiles: []}),
      };
      const toolset = new SkillToolset([skill], {
        codeExecutor: mockCodeExecutor as unknown as BaseCodeExecutor,
      });
      const runScriptTool = toolsfind(toolset, 'run_skill_script');
      await runScriptTool.runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/run.ps1'},
        toolContext: createMockContext(),
      });
      expect(mockCodeExecutor.executeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          codeExecutionInput: expect.objectContaining({
            code: '& .\\scripts\\run.ps1 $args',
            language: 'powershell',
          }),
        }),
      );
    });

    it('RunSkillScriptTool generates Windows CMD wrapper code', async () => {
      const skill: Skill = {
        frontmatter: {name: 'test-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          scripts: {
            'run.bat': {src: 'echo 123'},
          },
        },
      };
      const mockCodeExecutor = {
        executeCode: vi
          .fn()
          .mockResolvedValue({stdout: '', stderr: '', outputFiles: []}),
      };
      const toolset = new SkillToolset([skill], {
        codeExecutor: mockCodeExecutor as unknown as BaseCodeExecutor,
      });
      const runScriptTool = toolsfind(toolset, 'run_skill_script');
      await runScriptTool.runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/run.bat'},
        toolContext: createMockContext(),
      });
      expect(mockCodeExecutor.executeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          codeExecutionInput: expect.objectContaining({
            code: 'call .\\scripts\\run.bat %*',
            language: 'cmd',
          }),
        }),
      );
    });
  });
});

function toolsfind(toolset: SkillToolset, name: string): BaseTool {
  const tools = (toolset as unknown as {tools: BaseTool[]}).tools;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }
  return tool;
}
