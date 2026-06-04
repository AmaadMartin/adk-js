/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  Frontmatter,
  InvocationContext,
  LlmRequest,
  ReadonlyContext,
  Skill,
  SkillRegistry,
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

  function createMockContext(
    agentName = 'test-agent',
    invocationId = 'test-invocation-id',
  ) {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
        invocationId,
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

    describe('Skill Registry Integration', () => {
      const createMockRegistry = (options?: {
        getSkill?: (params: {name: string}) => Promise<Skill>;
        searchSkills?: (params: {query: string}) => Promise<Frontmatter[]>;
        searchToolDescription?: () => string | null;
      }): SkillRegistry => {
        return {
          getSkill: options?.getSkill || vi.fn().mockResolvedValue(mockSkill),
          searchSkills: options?.searchSkills || vi.fn().mockResolvedValue([]),
          searchToolDescription:
            options?.searchToolDescription || vi.fn().mockReturnValue(null),
        };
      };

      it('initializes with registry option and adds search_skills tool', async () => {
        const registry = createMockRegistry();
        const toolset = new SkillToolset([mockSkill], {registry});
        expect(toolset.registry).toBe(registry);

        const tools = await toolset.getTools();
        expect(tools.map((t) => t.name)).toContain('search_skills');
      });

      it('does not add search_skills tool when registry is not provided', async () => {
        const toolset = new SkillToolset([mockSkill]);
        expect(toolset.registry).toBeUndefined();

        const tools = await toolset.getTools();
        expect(tools.map((t) => t.name)).not.toContain('search_skills');
      });

      it('search_skills tool successfully searches registry and filters local conflicts', async () => {
        const mockSkillsList = [
          {name: 'remote-skill-1', description: 'Remote skill 1'},
          {name: 'test-skill', description: 'Conflict local skill'},
        ];
        const searchSkillsSpy = vi.fn().mockResolvedValue(mockSkillsList);
        const registry = createMockRegistry({searchSkills: searchSkillsSpy});
        const toolset = new SkillToolset([mockSkill], {registry});

        const searchTool = (await toolset.getTools()).find(
          (t) => t.name === 'search_skills',
        )!;

        const results = await searchTool.runAsync({
          args: {query: 'test-query'},
          toolContext: createMockContext(),
        });

        expect(searchSkillsSpy).toHaveBeenCalledWith({query: 'test-query'});
        expect(results).toEqual([
          {name: 'remote-skill-1', description: 'Remote skill 1'},
        ]);
      });

      it('search_skills tool throws if query is missing', async () => {
        const registry = createMockRegistry();
        const toolset = new SkillToolset([mockSkill], {registry});
        const searchTool = (await toolset.getTools()).find(
          (t) => t.name === 'search_skills',
        )!;

        const results = await searchTool.runAsync({
          args: {},
          toolContext: createMockContext(),
        });
        expect(results).toEqual({
          error: "Argument 'query' is required.",
          error_code: 'INVALID_ARGUMENTS',
        });
      });

      it('load_skill tool falls back to registry to fetch remote skill on demand', async () => {
        const remoteSkill: Skill = {
          frontmatter: {
            name: 'remote-skill',
            description: 'Remote description',
          },
          instructions: 'Remote instructions',
        };
        const getSkillSpy = vi.fn().mockResolvedValue(remoteSkill);
        const registry = createMockRegistry({getSkill: getSkillSpy});
        const toolset = new SkillToolset([], {registry});

        const loadTool = (await toolset.getTools()).find(
          (t) => t.name === 'load_skill',
        )!;

        const context = createMockContext();
        const results = (await loadTool.runAsync({
          args: {name: 'remote-skill'},
          toolContext: context,
        })) as unknown as Record<string, unknown>;

        expect(getSkillSpy).toHaveBeenCalledWith({name: 'remote-skill'});
        expect(results.skill_name).toBe('remote-skill');
        expect(results.instructions).toBe('Remote instructions');

        // Verify turn-scoped caching works: second call with same invocationId does not call registry again
        getSkillSpy.mockClear();
        const secondResults = (await loadTool.runAsync({
          args: {name: 'remote-skill'},
          toolContext: context,
        })) as unknown as Record<string, unknown>;

        expect(getSkillSpy).not.toHaveBeenCalled();
        expect(secondResults.skill_name).toBe('remote-skill');
      });

      it('turn-scoped cache evicted after max turns limit', async () => {
        const getSkillSpy = vi.fn().mockImplementation(async ({name}) => ({
          frontmatter: {name, description: 'desc'},
          instructions: 'instructions',
        }));
        const registry = createMockRegistry({getSkill: getSkillSpy});
        const toolset = new SkillToolset([], {registry});
        const loadTool = (await toolset.getTools()).find(
          (t) => t.name === 'load_skill',
        )!;

        // Load skill under 17 different invocation contexts
        for (let i = 0; i < 17; i++) {
          const context = new Context({
            invocationContext: {
              session: {state: {}},
              agent: {name: 'test-agent'},
              invocationId: `invocation-${i}`,
            } as unknown as InvocationContext,
          });
          await loadTool.runAsync({
            args: {name: 'skill-x'},
            toolContext: context,
          });
        }

        expect(getSkillSpy).toHaveBeenCalledTimes(17);

        // First invocation-0 cache should be evicted by now.
        // Let's call it again with invocation-0 context and see if it calls the registry again.
        getSkillSpy.mockClear();
        const firstContext = new Context({
          invocationContext: {
            session: {state: {}},
            agent: {name: 'test-agent'},
            invocationId: 'invocation-0',
          } as unknown as InvocationContext,
        });

        await loadTool.runAsync({
          args: {name: 'skill-x'},
          toolContext: firstContext,
        });

        expect(getSkillSpy).toHaveBeenCalledTimes(1);
      });

      it('resolves dynamic tools from registry skill and loads resources from registry skill', async () => {
        class CustomTool extends BaseTool {
          constructor() {
            super({name: 'custom_tool', description: 'custom'});
          }
          _getDeclaration() {
            return {name: 'custom_tool', description: 'custom'};
          }
          async runAsync() {
            return 'custom';
          }
        }
        const customTool = new CustomTool();

        const registrySkill: Skill = {
          frontmatter: {
            name: 'registry-skill-with-tools',
            description: 'Registry description',
            metadata: {
              adk_additional_tools: ['custom_tool'],
            },
          },
          instructions: 'Registry instructions',
          resources: {
            references: {
              'ref.md': 'Registry ref content',
            },
          },
        };

        const registry = createMockRegistry({
          getSkill: vi.fn().mockResolvedValue(registrySkill),
        });

        const toolset = new SkillToolset([], {
          registry,
          additionalTools: [customTool],
        });

        const mockState = {
          get: vi.fn().mockReturnValue(['registry-skill-with-tools']),
        };

        const context = {
          agentName: 'test-agent',
          invocationId: 'turn-1',
          state: mockState,
        } as unknown as ReadonlyContext;

        // 1. Verify dynamic tools are resolved
        const tools = await toolset.getTools(context);
        expect(tools.map((t) => t.name)).toContain('custom_tool');

        // 2. Verify load_skill_resource tool resolves resources
        const resourceTool = tools.find(
          (t) => t.name === 'load_skill_resource',
        )!;
        const resContext = new Context({
          invocationContext: {
            session: {state: {}},
            agent: {name: 'test-agent'},
            invocationId: 'turn-1',
          } as unknown as InvocationContext,
        });
        const resResult = (await resourceTool.runAsync({
          args: {
            skill_name: 'registry-skill-with-tools',
            path: 'references/ref.md',
          },
          toolContext: resContext,
        })) as unknown as Record<string, unknown>;

        expect(resResult.content).toBe('Registry ref content');
      });

      it('appends registry instruction to LLM request', async () => {
        const registry = createMockRegistry();
        const toolset = new SkillToolset([mockSkill], {registry});
        const llmRequest: LlmRequest = {
          contents: [],
          toolsDict: {},
          liveConnectConfig: {},
        };

        await toolset.processLlmRequest(createMockContext(), llmRequest);

        expect(llmRequest.config?.systemInstruction).toContain(
          'you can use the `search_skills` tool to discover additional skills',
        );
      });
    });
  });
});
