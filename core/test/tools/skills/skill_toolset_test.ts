/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  InvocationContext,
  LlmRequest,
  ReadonlyContext,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

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
  });
});
