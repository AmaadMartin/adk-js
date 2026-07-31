/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentConfigErrorCode,
  BaseAgent,
  BaseAgentConfig,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BaseToolset,
  Event,
  FunctionTool,
  InvocationContext,
  isLlmAgent,
  isLoopAgent,
  isParallelAgent,
  isSequentialAgent,
  LlmRequest,
  LlmResponse,
  loadAgentFromConfigFile,
  LoadAgentOptions,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';

class TestLlm extends BaseLlm {
  constructor() {
    super({model: 'test-llm'});
  }
  generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

class TestToolset extends BaseToolset {
  constructor() {
    super([]);
  }
  async getTools(): Promise<BaseTool[]> {
    return [];
  }
  async close(): Promise<void> {}
}

interface GreetingAgentConfig extends BaseAgentConfig {
  greeting?: string;
}

class GreetingAgent extends BaseAgent<GreetingAgentConfig> {
  readonly greeting?: string;

  constructor(config: GreetingAgentConfig) {
    super(config);
    this.greeting = config.greeting;
  }
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

class NotAnAgent {}

const testTool = new FunctionTool({
  name: 'test_tool',
  description: 'A tool used by the config loader tests.',
  execute: () => ({ok: true}),
});

const LLM_DOC = `
name: writer
instruction: Write the requested code.
`;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, {recursive: true, force: true})),
  );
});

/** Writes `files` (relative path -> contents) into a fresh temp directory. */
async function writeConfigs(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-agent-config-'));
  tempDirs.push(dir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, contents);
  }
  return dir;
}

/** Builds options resolving references from a fixed lookup table. */
function resolvingTo(references: Record<string, unknown>): LoadAgentOptions {
  return {resolveReference: (name: string) => references[name]};
}

function errorWithCode(code: AgentConfigErrorCode) {
  return expect.objectContaining({code});
}

describe('loadAgentFromConfigFile', () => {
  it.each([
    ['LlmAgent', 'llm_agent', isLlmAgent, 'instruction: Do the thing.'],
    ['LoopAgent', 'loop_agent', isLoopAgent, ''],
    ['ParallelAgent', 'parallel_agent', isParallelAgent, ''],
    ['SequentialAgent', 'sequential_agent', isSequentialAgent, ''],
  ])(
    'loads a %s written in any of its three spellings',
    async (bareName, moduleName, isExpectedClass, extraFields) => {
      const spellings = [
        bareName,
        `google.adk.agents.${bareName}`,
        `google.adk.agents.${moduleName}.${bareName}`,
      ];

      for (const spelling of spellings) {
        const dir = await writeConfigs({
          'root.yaml': `
agent_class: ${spelling}
name: root
${extraFields}
`,
        });
        const agent = await loadAgentFromConfigFile(
          path.join(dir, 'root.yaml'),
        );
        expect(isExpectedClass(agent)).toBe(true);
        expect(agent.name).toBe('root');
      }
    },
  );

  it('loads a document with no agent_class as an LlmAgent', async () => {
    const dir = await writeConfigs({'root.yaml': LLM_DOC});

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(isLlmAgent(agent)).toBe(true);
    expect(agent.name).toBe('writer');
  });

  it('loads a document with an empty agent_class as an LlmAgent', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: ''
name: writer
instruction: Write the requested code.
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(isLlmAgent(agent)).toBe(true);
    expect(agent.name).toBe('writer');
  });

  it('resolves a relative config path against the working directory', async () => {
    const dir = await writeConfigs({'root.yaml': LLM_DOC});

    const agent = await loadAgentFromConfigFile(
      path.relative(process.cwd(), path.join(dir, 'root.yaml')),
    );

    expect(agent.name).toBe('writer');
  });

  it('loads sub-agents in document order and parents them', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: pipeline
description: Writes then reviews.
sub_agents:
  - config_path: sub_agents/writer.yaml
  - config_path: sub_agents/reviewer.yaml
`,
      'sub_agents/writer.yaml': `
name: writer
instruction: Write code.
`,
      'sub_agents/reviewer.yaml': `
agent_class: LoopAgent
name: reviewer
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(isSequentialAgent(agent)).toBe(true);
    expect(agent.description).toBe('Writes then reviews.');
    expect(agent.subAgents.map((subAgent) => subAgent.name)).toEqual([
      'writer',
      'reviewer',
    ]);
    expect(isLlmAgent(agent.subAgents[0])).toBe(true);
    expect(isLoopAgent(agent.subAgents[1])).toBe(true);
    for (const subAgent of agent.subAgents) {
      expect(subAgent.parentAgent).toBe(agent);
    }
  });

  it('resolves a nested config path against the referencing file', async () => {
    const dir = await writeConfigs({
      'level1/level2/nested_main.yaml': `
agent_class: SequentialAgent
name: nested_main
sub_agents:
  - config_path: sub/nested_child.yaml
`,
      'level1/level2/sub/nested_child.yaml': `
name: nested_child
instruction: Be nested.
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'level1/level2/nested_main.yaml'),
    );

    expect(agent.subAgents[0].name).toBe('nested_child');
  });

  it('resolves a config path written with backslash separators', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: sub\\child.yaml
`,
      'sub/child.yaml': `
name: child
instruction: Be a child.
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(agent.subAgents[0].name).toBe('child');
  });

  it('rejects an absolute sub-agent config path', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: /absolute/child.yaml
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.ABSOLUTE_SUB_AGENT_PATH),
    );
  });

  it('rejects a sub-agent config path escaping the referencing directory', async () => {
    const dir = await writeConfigs({
      'agents/root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: ../outside.yaml
`,
      'outside.yaml': `
name: outside
instruction: Be outside.
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'agents/root.yaml')),
    ).rejects.toThrowError(errorWithCode(AgentConfigErrorCode.PATH_TRAVERSAL));
  });

  // Creating a symlink on Windows needs a privilege the CI runner may not
  // hold, so the symlink cases run on POSIX only. The behaviour they pin is
  // platform-independent.
  it.skipIf(process.platform === 'win32')(
    'rejects a sub-agent config path that symlinks outside the referencing directory',
    async () => {
      const dir = await writeConfigs({
        'agents/root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: escape.yaml
`,
        'outside/secret.yaml': `
name: outside
instruction: Be outside.
`,
      });
      await fs.symlink(
        path.join(dir, 'outside/secret.yaml'),
        path.join(dir, 'agents/escape.yaml'),
      );

      await expect(
        loadAgentFromConfigFile(path.join(dir, 'agents/root.yaml')),
      ).rejects.toThrowError(
        errorWithCode(AgentConfigErrorCode.PATH_TRAVERSAL),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'follows a sub-agent config path that symlinks within the referencing directory',
    async () => {
      const dir = await writeConfigs({
        'agents/root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: link.yaml
`,
        'agents/real/child.yaml': `
name: child
instruction: Be a child.
`,
      });
      await fs.symlink(
        path.join(dir, 'agents/real/child.yaml'),
        path.join(dir, 'agents/link.yaml'),
      );

      const agent = await loadAgentFromConfigFile(
        path.join(dir, 'agents/root.yaml'),
      );

      expect(agent.subAgents.map((subAgent) => subAgent.name)).toEqual([
        'child',
      ]);
    },
  );

  it('reports a missing config file', async () => {
    const dir = await writeConfigs({'root.yaml': LLM_DOC});

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'missing.yaml')),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.CONFIG_FILE_NOT_FOUND),
    );
  });

  it('reports a missing sub-agent config file', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: sub_agents/missing.yaml
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.CONFIG_FILE_NOT_FOUND),
    );
  });

  it('rethrows a read failure that is not a missing file', async () => {
    const dir = await writeConfigs({'root.yaml': LLM_DOC});

    // The raw Node error surfaces with its own errno code (EISDIR on the
    // platforms tested); the errno is not pinned, only that it is one and that
    // the failure was not relabelled as a config error.
    await expect(loadAgentFromConfigFile(dir)).rejects.toMatchObject({
      code: expect.stringMatching(/^E[A-Z]+$/),
    });
    await expect(loadAgentFromConfigFile(dir)).rejects.not.toMatchObject({
      name: 'AgentConfigError',
    });
  });

  it('reports malformed YAML with the parser detail', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
  instruction: badly indented
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(/bad indentation/);
  });

  it('loads a JSON config document', async () => {
    const dir = await writeConfigs({
      'root.json': JSON.stringify({
        agent_class: 'LoopAgent',
        name: 'json_root',
        max_iterations: 2,
      }),
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.json'));

    if (!isLoopAgent(agent)) {
      expect.fail('Expected a LoopAgent.');
    }
    expect(agent.maxIterations).toBe(2);
  });

  it.each([
    ['omitted', ''],
    ['zero', 'max_iterations: 0'],
  ])(
    'leaves max_iterations at the LoopAgent default when %s',
    async (_label, maxIterationsField) => {
      const dir = await writeConfigs({
        'root.yaml': `
agent_class: LoopAgent
name: looper
${maxIterationsField}
`,
      });

      const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

      if (!isLoopAgent(agent)) {
        expect.fail('Expected a LoopAgent.');
      }
      expect(agent.maxIterations).toBe(Number.MAX_SAFE_INTEGER);
    },
  );

  it('rejects a non-integer max_iterations', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: LoopAgent
name: looper
max_iterations: 2.7
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(errorWithCode(AgentConfigErrorCode.INVALID_CONFIG));
  });

  it('re-validates a qualified agent_class against the strict schema', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: google.adk.agents.LoopAgent
name: looper
not_a_field: true
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(errorWithCode(AgentConfigErrorCode.INVALID_CONFIG));
  });
});

describe('loadAgentFromConfigFile LlmAgent fields', () => {
  it('maps every scalar LlmAgent field onto the agent', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
model: gemini-2.5-flash
description: Writes code.
instruction: Write the requested code.
output_key: draft
include_contents: none
disallow_transfer_to_parent: true
disallow_transfer_to_peers: true
generate_content_config:
  temperature: 0.25
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(isLlmAgent(agent)).toBe(true);
    if (!isLlmAgent(agent)) {
      expect.fail('Expected an LlmAgent.');
    }
    expect(agent.model).toBe('gemini-2.5-flash');
    expect(agent.description).toBe('Writes code.');
    expect(agent.instruction).toBe('Write the requested code.');
    expect(agent.outputKey).toBe('draft');
    expect(agent.includeContents).toBe('none');
    expect(agent.disallowTransferToParent).toBe(true);
    expect(agent.disallowTransferToPeers).toBe(true);
    expect(agent.generateContentConfig).toEqual({temperature: 0.25});
  });

  it('keeps the LlmAgent defaults when the optional fields are omitted', async () => {
    const dir = await writeConfigs({'root.yaml': LLM_DOC});

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(isLlmAgent(agent)).toBe(true);
    if (!isLlmAgent(agent)) {
      expect.fail('Expected an LlmAgent.');
    }
    expect(agent.model).toBeUndefined();
    expect(agent.includeContents).toBe('default');
    expect(agent.disallowTransferToParent).toBe(false);
    expect(agent.disallowTransferToPeers).toBe(false);
    expect(agent.outputKey).toBeUndefined();
    expect(agent.generateContentConfig).toEqual({});
    expect(agent.tools).toEqual([]);
  });

  it('resolves model_code to the model instance it names', async () => {
    const model = new TestLlm();
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
model_code:
  name: mylib.models.my_model
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({'mylib.models.my_model': model}),
    );

    expect(isLlmAgent(agent)).toBe(true);
    if (!isLlmAgent(agent)) {
      expect.fail('Expected an LlmAgent.');
    }
    expect(agent.model).toBe(model);
  });

  it('rejects a model_code that does not name a model', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
model_code:
  name: mylib.models.not_a_model
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.models.not_a_model': 'gemini-2.5-flash'}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNRESOLVED_REFERENCE),
    );
  });

  it('resolves tools to the tool and toolset instances they name', async () => {
    const toolset = new TestToolset();
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
tools:
  - name: mylib.tools.my_tool
  - name: mylib.tools.my_toolset
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({
        'mylib.tools.my_tool': testTool,
        'mylib.tools.my_toolset': toolset,
      }),
    );

    expect(isLlmAgent(agent)).toBe(true);
    if (!isLlmAgent(agent)) {
      expect.fail('Expected an LlmAgent.');
    }
    expect(agent.tools).toEqual([testTool, toolset]);
  });

  it('rejects a tool reference that names something else', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
tools:
  - name: mylib.tools.not_a_tool
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.tools.not_a_tool': 42}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNRESOLVED_REFERENCE),
    );
  });

  it('resolves input_schema and output_schema', async () => {
    const inputSchema = {type: 'object', properties: {}};
    const outputSchema = {type: 'object', properties: {}};
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
input_schema:
  name: mylib.schemas.input
output_schema:
  name: mylib.schemas.output
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({
        'mylib.schemas.input': inputSchema,
        'mylib.schemas.output': outputSchema,
      }),
    );

    expect(isLlmAgent(agent)).toBe(true);
    if (!isLlmAgent(agent)) {
      expect.fail('Expected an LlmAgent.');
    }
    expect(agent.inputSchema).toBe(inputSchema);
    expect(agent.outputSchema).toBe(outputSchema);
  });

  it('rejects an input_schema reference that names a non-object', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
input_schema:
  name: mylib.schemas.not_a_schema
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.schemas.not_a_schema': 'object'}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNRESOLVED_REFERENCE),
    );
  });

  it('resolves the model and tool callbacks', async () => {
    const beforeModel = () => undefined;
    const afterModel = () => undefined;
    const beforeTool = () => undefined;
    const afterTool = () => undefined;
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
before_model_callbacks:
  - name: mylib.callbacks.before_model
after_model_callbacks:
  - name: mylib.callbacks.after_model
before_tool_callbacks:
  - name: mylib.callbacks.before_tool
after_tool_callbacks:
  - name: mylib.callbacks.after_tool
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({
        'mylib.callbacks.before_model': beforeModel,
        'mylib.callbacks.after_model': afterModel,
        'mylib.callbacks.before_tool': beforeTool,
        'mylib.callbacks.after_tool': afterTool,
      }),
    );

    expect(isLlmAgent(agent)).toBe(true);
    if (!isLlmAgent(agent)) {
      expect.fail('Expected an LlmAgent.');
    }
    expect(agent.beforeModelCallback).toEqual([beforeModel]);
    expect(agent.afterModelCallback).toEqual([afterModel]);
    expect(agent.beforeToolCallback).toEqual([beforeTool]);
    expect(agent.afterToolCallback).toEqual([afterTool]);
  });
});

describe('loadAgentFromConfigFile agent callbacks', () => {
  it('resolves the before and after agent callbacks', async () => {
    const before = () => undefined;
    const after = () => undefined;
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
before_agent_callbacks:
  - name: mylib.callbacks.before
after_agent_callbacks:
  - name: mylib.callbacks.after
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({
        'mylib.callbacks.before': before,
        'mylib.callbacks.after': after,
      }),
    );

    expect(agent.beforeAgentCallback).toEqual([before]);
    expect(agent.afterAgentCallback).toEqual([after]);
  });

  it('treats empty reference lists as absent', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
sub_agents: []
before_agent_callbacks: []
after_agent_callbacks: []
tools: []
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(agent.subAgents).toEqual([]);
    expect(agent.beforeAgentCallback).toEqual([]);
    expect(agent.afterAgentCallback).toEqual([]);
  });

  it('rejects a callback reference that does not name a function', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
name: writer
instruction: Write code.
before_agent_callbacks:
  - name: mylib.callbacks.not_a_function
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.callbacks.not_a_function': {}}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNRESOLVED_REFERENCE),
    );
  });
});

describe('loadAgentFromConfigFile reference resolution', () => {
  it.each([
    [
      'model_code',
      `
name: writer
instruction: Write code.
model_code:
  name: mylib.models.my_model
`,
    ],
    [
      'before_agent_callbacks',
      `
name: writer
instruction: Write code.
before_agent_callbacks:
  - name: mylib.callbacks.before
`,
    ],
    [
      'tools',
      `
name: writer
instruction: Write code.
tools:
  - name: mylib.tools.my_tool
`,
    ],
    [
      'a code sub-agent',
      `
agent_class: SequentialAgent
name: root
sub_agents:
  - code: mylib.agents.child
`,
    ],
  ])(
    'reports an unresolved %s when no resolver is supplied',
    async (_field, document) => {
      const dir = await writeConfigs({'root.yaml': document});

      await expect(
        loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
      ).rejects.toThrowError(
        errorWithCode(AgentConfigErrorCode.UNRESOLVED_REFERENCE),
      );
    },
  );

  it('uses a code sub-agent reference directly', async () => {
    const child = new GreetingAgent({name: 'child'});
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - code: mylib.agents.child
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({'mylib.agents.child': child}),
    );

    expect(agent.subAgents).toEqual([child]);
  });

  it('rejects a code sub-agent reference that names a non-agent', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - code: mylib.agents.not_an_agent
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.agents.not_an_agent': {name: 'nope'}}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.INVALID_AGENT_REFERENCE),
    );
  });
});

describe('loadAgentFromConfigFile custom agent classes', () => {
  it('passes the extra document fields to the resolved constructor', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: mylib.agents.GreetingAgent
name: greeter
description: Greets.
greeting: hello
unused_field: ignored
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({'mylib.agents.GreetingAgent': GreetingAgent}),
    );

    expect(agent.name).toBe('greeter');
    expect(agent.description).toBe('Greets.');
    expect(agent).toMatchObject({greeting: 'hello'});
  });

  it('reports an unsupported agent class when no resolver is supplied', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: mylib.agents.GreetingAgent
name: greeter
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNSUPPORTED_AGENT_CLASS),
    );
  });

  it('reports an agent class that resolves to a non-constructor', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: mylib.agents.GreetingAgent
name: greeter
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.agents.GreetingAgent': {}}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNSUPPORTED_AGENT_CLASS),
    );
  });

  it('reports an agent class that does not construct an agent', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: mylib.agents.NotAnAgent
name: greeter
`,
    });

    await expect(
      loadAgentFromConfigFile(
        path.join(dir, 'root.yaml'),
        resolvingTo({'mylib.agents.NotAnAgent': NotAnAgent}),
      ),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.UNSUPPORTED_AGENT_CLASS),
    );
  });

  it('gives a custom agent class its sub-agents and callbacks', async () => {
    const before = () => undefined;
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: mylib.agents.GreetingAgent
name: greeter
sub_agents:
  - config_path: child.yaml
before_agent_callbacks:
  - name: mylib.callbacks.before
`,
      'child.yaml': `
name: child
instruction: Be a child.
`,
    });

    const agent = await loadAgentFromConfigFile(
      path.join(dir, 'root.yaml'),
      resolvingTo({
        'mylib.agents.GreetingAgent': GreetingAgent,
        'mylib.callbacks.before': before,
      }),
    );

    expect(agent.subAgents.map((subAgent) => subAgent.name)).toEqual(['child']);
    expect(agent.beforeAgentCallback).toEqual([before]);
  });
});

describe('loadAgentFromConfigFile cycles', () => {
  it('reports a circular sub-agent reference', async () => {
    const dir = await writeConfigs({
      'a.yaml': `
agent_class: SequentialAgent
name: a
sub_agents:
  - config_path: b.yaml
`,
      'b.yaml': `
agent_class: SequentialAgent
name: b
sub_agents:
  - config_path: a.yaml
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'a.yaml')),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.CIRCULAR_SUB_AGENT_REFERENCE),
    );
  });

  it('loads the same config twice when the references are not nested', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: shared.yaml
  - config_path: shared.yaml
`,
      'shared.yaml': `
name: shared
instruction: Be shared.
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(agent.subAgents).toHaveLength(2);
    expect(agent.subAgents[0]).not.toBe(agent.subAgents[1]);
    expect(agent.subAgents[1].parentAgent).toBe(agent);
  });
});

describe('loadAgentFromConfigFile sub-agent references', () => {
  it('builds a ParallelAgent with its config_path sub-agent', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: ParallelAgent
name: root
sub_agents:
  - config_path: sub_agents/child.yaml
`,
      'sub_agents/child.yaml': `
name: child
instruction: Be a child.
`,
    });

    const agent = await loadAgentFromConfigFile(path.join(dir, 'root.yaml'));

    expect(isParallelAgent(agent)).toBe(true);
    expect(agent.subAgents.map((subAgent) => subAgent.name)).toEqual(['child']);
  });

  it.each([["config_path: ''"], ["code: ''"]])(
    'rejects the sub-agent reference { %s }, which names neither',
    async (referenceField) => {
      const dir = await writeConfigs({
        'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - ${referenceField}
`,
      });

      await expect(
        loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
      ).rejects.toThrowError(
        errorWithCode(AgentConfigErrorCode.INVALID_AGENT_REFERENCE),
      );
    },
  );

  it('rejects a config_path that points back at the referencing config', async () => {
    const dir = await writeConfigs({
      'root.yaml': `
agent_class: SequentialAgent
name: root
sub_agents:
  - config_path: root.yaml
`,
    });

    await expect(
      loadAgentFromConfigFile(path.join(dir, 'root.yaml')),
    ).rejects.toThrowError(
      errorWithCode(AgentConfigErrorCode.CIRCULAR_SUB_AGENT_REFERENCE),
    );
  });
});
