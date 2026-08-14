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
// Imported from the source path so the spy targets the same module instance
// that `@google/adk` resolves to.
import {logger} from '../../../src/utils/logger.js';

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
      expect(tools.length).toBe(4);
      expect(tools.map((t) => t.name)).toEqual([
        'list_skills',
        'load_skill',
        'load_skill_resource',
        'run_skill_script',
      ]);
    });

    it('returns default tools only when no skills activated', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const context = createMockContext();
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(4);
    });

    it('does not expose the inline-script tool by default', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).not.toContain('run_skill_inline_script');
    });

    it('does not expose the inline-script tool when the flag is false', async () => {
      const toolset = new SkillToolset([mockSkill], {
        allowInlineScripts: false,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).not.toContain('run_skill_inline_script');
    });

    it('exposes the inline-script tool when allowInlineScripts is true', async () => {
      const toolset = new SkillToolset([mockSkill], {
        allowInlineScripts: true,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toContain('run_skill_inline_script');
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

    describe('SkillToolset close - additional toolsets', () => {
      class SpyToolset extends BaseToolset {
        constructor(private readonly onClose: () => Promise<void>) {
          super([]);
        }
        override async getTools() {
          return [];
        }
        override async close(): Promise<void> {
          await this.onClose();
        }
      }

      it('closes every nested toolset exactly once', async () => {
        const closeFirst = vi.fn().mockResolvedValue(undefined);
        const closeSecond = vi.fn().mockResolvedValue(undefined);
        const toolset = new SkillToolset([mockSkill], {
          additionalTools: [
            new SpyToolset(closeFirst),
            new SpyToolset(closeSecond),
          ],
        });

        await toolset.close();

        expect(closeFirst).toHaveBeenCalledTimes(1);
        expect(closeSecond).toHaveBeenCalledTimes(1);
      });

      it('leaves plain tools alone', async () => {
        const toolClose = vi.fn().mockResolvedValue(undefined);
        class ClosableTool extends BaseTool {
          constructor() {
            super({name: 'closable_tool', description: 'dummy'});
          }
          close = toolClose;
          async runAsync() {
            return 'dummy';
          }
        }
        const toolsetClose = vi.fn().mockResolvedValue(undefined);
        const toolset = new SkillToolset([mockSkill], {
          additionalTools: [new ClosableTool(), new SpyToolset(toolsetClose)],
        });

        await toolset.close();

        expect(toolClose).not.toHaveBeenCalled();
        expect(toolsetClose).toHaveBeenCalledTimes(1);
      });

      it('keeps closing after one nested toolset rejects', async () => {
        const closeFirst = vi.fn().mockResolvedValue(undefined);
        const closeRejecting = vi.fn().mockRejectedValue(new Error('boom'));
        const closeLast = vi.fn().mockResolvedValue(undefined);
        const toolset = new SkillToolset([mockSkill], {
          additionalTools: [
            new SpyToolset(closeFirst),
            new SpyToolset(closeRejecting),
            new SpyToolset(closeLast),
          ],
        });

        await expect(toolset.close()).resolves.toBeUndefined();

        expect(closeFirst).toHaveBeenCalledTimes(1);
        expect(closeRejecting).toHaveBeenCalledTimes(1);
        expect(closeLast).toHaveBeenCalledTimes(1);
      });

      it('closes a toolset that carries the signature but is not an instance', async () => {
        const foreignClose = vi.fn().mockResolvedValue(undefined);
        // Stands in for a toolset built by a second copy of the ADK package,
        // which fails `instanceof` but carries the shared toolset signature.
        const foreignToolset = {
          [Symbol.for('google.adk.baseToolset')]: true,
          getTools: vi.fn().mockResolvedValue([]),
          close: foreignClose,
        } as unknown as BaseToolset;
        const toolset = new SkillToolset([mockSkill], {
          additionalTools: [foreignToolset],
        });

        await toolset.close();

        expect(foreignClose).toHaveBeenCalledTimes(1);
      });

      it('still clears the fetched-skill cache when a nested close rejects', async () => {
        const remoteSkill: Skill = {
          frontmatter: {
            name: 'remote-skill',
            description: 'A remote skill',
          },
          instructions: 'Remote instructions',
        };
        const registry = {
          getSkill: vi.fn().mockResolvedValue(remoteSkill),
          searchSkills: vi.fn(),
        };
        const toolset = new SkillToolset([mockSkill], {
          registry,
          additionalTools: [
            new SpyToolset(vi.fn().mockRejectedValue(new Error('boom'))),
          ],
        });

        await toolset.getOrFetchSkill('remote-skill', 'inv-1');
        expect(registry.getSkill).toHaveBeenCalledTimes(1);

        await toolset.close();
        await toolset.getOrFetchSkill('remote-skill', 'inv-1');

        expect(registry.getSkill).toHaveBeenCalledTimes(2);
      });

      it('reports a nested toolset that fails to close', async () => {
        const toolset = new SkillToolset([mockSkill], {
          additionalTools: [
            new SpyToolset(vi.fn().mockResolvedValue(undefined)),
            new SpyToolset(vi.fn().mockRejectedValue(new Error('boom'))),
          ],
        });
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

        try {
          await toolset.close();

          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0][0]).toContain('boom');
        } finally {
          warn.mockRestore();
        }
      });

      it('clears the fetched-skill cache before it awaits a nested close', async () => {
        const remoteSkill: Skill = {
          frontmatter: {
            name: 'remote-skill',
            description: 'A remote skill',
          },
          instructions: 'Remote instructions',
        };
        const registry = {
          getSkill: vi.fn().mockResolvedValue(remoteSkill),
          searchSkills: vi.fn(),
        };
        let releaseNestedClose!: () => void;
        const nestedClose = new Promise<void>((resolve) => {
          releaseNestedClose = resolve;
        });
        const toolset = new SkillToolset([mockSkill], {
          registry,
          additionalTools: [new SpyToolset(() => nestedClose)],
        });

        await toolset.getOrFetchSkill('remote-skill', 'inv-1');
        await toolset.getOrFetchSkill('remote-skill', 'inv-1');
        expect(registry.getSkill).toHaveBeenCalledTimes(1);

        const closed = toolset.close();
        await toolset.getOrFetchSkill('remote-skill', 'inv-1');

        expect(registry.getSkill).toHaveBeenCalledTimes(2);

        releaseNestedClose();
        await expect(closed).resolves.toBeUndefined();
      });

      it('is safe to call twice', async () => {
        const nestedClose = vi.fn().mockResolvedValue(undefined);
        const toolset = new SkillToolset([mockSkill], {
          additionalTools: [new SpyToolset(nestedClose)],
        });

        await expect(toolset.close()).resolves.toBeUndefined();
        await expect(toolset.close()).resolves.toBeUndefined();

        expect(nestedClose).toHaveBeenCalledTimes(2);
      });

      it('resolves when there are no additional tools', async () => {
        const toolset = new SkillToolset([mockSkill]);

        await expect(toolset.close()).resolves.toBeUndefined();
      });
    });
  });
});
