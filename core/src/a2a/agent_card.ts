/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, AgentInterface, AgentSkill} from '@a2a-js/sdk';
import {DefaultAgentCardResolver} from '@a2a-js/sdk/client';
import * as fs from 'node:fs/promises';
import {BaseAgent} from '../agents/base_agent.js';
import {
  InvocationContext,
  InvocationContextParams,
} from '../agents/invocation_context.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {isLoopAgent, LoopAgent} from '../agents/loop_agent.js';
import {isParallelAgent} from '../agents/parallel_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {isSequentialAgent} from '../agents/sequential_agent.js';
import {BaseTool, isBaseTool} from '../tools/base_tool.js';
import {isBaseToolset} from '../tools/base_toolset.js';
import {formatError, isFileNotFoundError} from '../utils/error_utils.js';
import {quoteUntrusted} from '../utils/fencing_utils.js';
import {logger} from '../utils/logger.js';
import {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {isWorkflow} from '../workflow/workflow.js';

/**
 * A card description fetched over the network is peer-controlled text that a
 * parent agent puts in its own instruction, so it is capped before being fenced.
 */
const MAX_CARD_DESCRIPTION_CHARS = 1024;

/**
 * Marks a capped description as incomplete, so neither the model nor a reader
 * takes the cut-off text for the whole description.
 */
const CARD_DESCRIPTION_TRUNCATION_SUFFIX = '... [truncated]';

/** Raised when an agent card cannot be resolved or fails validation. */
export class AgentCardResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCardResolutionError';
  }
}

/**
 * Whether a thrown value is an {@link AgentCardResolutionError}.
 *
 * Matches on the error name rather than `instanceof`, so the check still holds
 * when two copies of this package are loaded in one runtime.
 */
export function isAgentCardResolutionError(
  err: unknown,
): err is AgentCardResolutionError {
  return err instanceof Error && err.name === 'AgentCardResolutionError';
}

/** Whether an agent card source names a location fetched over the network. */
export function isRemoteCardSource(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

/** Per-request options for {@link resolveAgentCard}. */
export interface ResolveAgentCardOptions {
  /** Extra HTTP headers to send with the card fetch. */
  headers?: Record<string, string>;
  /** Milliseconds after which the card fetch is aborted. */
  timeoutMs?: number;
  /** The `fetch` implementation to use. Defaults to the global one. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns the description to adopt from a resolved agent card.
 *
 * A parent agent interpolates a transfer target's description straight into its
 * own instruction, so a description that arrived over the network is capped and
 * fenced as quoted peer content. A card supplied directly or read from a local
 * file is the caller's own text and is adopted unchanged.
 *
 * @param description The description the card carries.
 * @param source The location the card came from, if it came from one.
 * @return The description the agent adopts.
 */
export function adoptedCardDescription(
  description: string,
  source?: string,
): string {
  if (!source || !isRemoteCardSource(source)) {
    return description;
  }
  let capped = description.slice(0, MAX_CARD_DESCRIPTION_CHARS);
  if (capped.length < description.length) {
    capped += CARD_DESCRIPTION_TRUNCATION_SUFFIX;
  }
  return quoteUntrusted(capped);
}

/**
 * Resolves the AgentCard from the provided source.
 *
 * @param agentCard A card object, a URL to fetch it from, or a file path.
 * @param options Headers, timeout and `fetch` override for a URL source.
 * @return The resolved card.
 * @throws {AgentCardResolutionError} If the source cannot be read or parsed.
 */
export async function resolveAgentCard(
  agentCard: AgentCard | string,
  options: ResolveAgentCardOptions = {},
): Promise<AgentCard> {
  if (typeof agentCard === 'object') {
    return agentCard;
  }

  const source = agentCard;
  if (isRemoteCardSource(source)) {
    const resolver = new DefaultAgentCardResolver({
      fetchImpl: buildCardFetch(options),
    });
    try {
      return await resolver.resolve(source);
    } catch (err: unknown) {
      throw new AgentCardResolutionError(
        `Failed to resolve AgentCard from URL ${source}: ${formatError(err)}`,
      );
    }
  }

  return readAgentCardFile(source);
}

/** Reads and parses an agent card from a local file. */
async function readAgentCardFile(source: string): Promise<AgentCard> {
  let content: string;
  try {
    content = await fs.readFile(source, 'utf-8');
  } catch (err: unknown) {
    if (isFileNotFoundError(err)) {
      throw new AgentCardResolutionError(
        `Agent card file not found: ${source}`,
      );
    }
    throw new AgentCardResolutionError(
      `Failed to resolve AgentCard from file ${source}: ${formatError(err)}`,
    );
  }
  try {
    return JSON.parse(content) as AgentCard;
  } catch (err: unknown) {
    throw new AgentCardResolutionError(
      `Invalid JSON in agent card file ${source}: ${formatError(err)}`,
    );
  }
}

/**
 * Wraps `fetch` so the card request carries the caller's headers and is bounded
 * by the caller's timeout. Returns the caller's implementation unchanged when
 * there is nothing to add.
 */
function buildCardFetch(
  options: ResolveAgentCardOptions,
): typeof fetch | undefined {
  const {headers, timeoutMs, fetchImpl} = options;
  if (!headers && timeoutMs === undefined) {
    return fetchImpl;
  }
  const baseFetch = fetchImpl ?? fetch;
  return (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers ?? {})) {
      merged.set(name, value);
    }
    return baseFetch(input, {
      ...init,
      headers: merged,
      ...(timeoutMs === undefined
        ? {}
        : {signal: AbortSignal.timeout(timeoutMs)}),
    });
  };
}

/**
 * Converts an ADK agent to an A2A AgentCard.
 */
export async function getA2AAgentCard(
  agent: RunnableRoot,
  transports: AgentInterface[],
): Promise<AgentCard> {
  return {
    name: agent.name,
    description: agent.description || '',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    skills: await buildAgentSkills(agent),
    url: transports[0].url,
    preferredTransport: transports[0].transport,
    capabilities: {
      extensions: [],
      stateTransitionHistory: false,
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    additionalInterfaces: transports,
  };
}

/**
 * Builds a list of AgentSkills based on agent descriptions and types.
 * This information can be used in AgentCard to help clients understand agent capabilities.
 *
 * @param agent The agent to build skills for.
 * @returns A promise resolving to a list of AgentSkills.
 */
export async function buildAgentSkills(
  agent: RunnableRoot,
): Promise<AgentSkill[]> {
  const [primarySkills, subAgentSkills] = await Promise.all([
    buildPrimarySkills(agent),
    buildSubAgentSkills(agent),
  ]);

  return [...primarySkills, ...subAgentSkills];
}

async function buildPrimarySkills(agent: RunnableRoot): Promise<AgentSkill[]> {
  if (isWorkflow(agent)) {
    // A workflow advertises itself as one skill. It has no sub-agents to
    // enumerate, and its internals are a graph rather than a roster.
    return [
      {
        id: agent.name,
        name: 'workflow',
        description: agent.description || `Workflow ${agent.name}`,
        tags: ['workflow'],
      },
    ];
  }
  if (isLlmAgent(agent)) {
    return buildLLMAgentSkills(agent);
  }

  return buildNonLLMAgentSkills(agent);
}

async function buildSubAgentSkills(agent: RunnableRoot): Promise<AgentSkill[]> {
  // A workflow has nodes, not sub-agents: its shape is described by the single
  // `workflow` skill rather than one skill per child.
  const subAgents = isWorkflow(agent) ? [] : agent.subAgents;
  const result: AgentSkill[] = [];

  for (const sub of subAgents) {
    const skills = await buildPrimarySkills(sub);
    for (const subSkill of skills) {
      const skill: AgentSkill = {
        id: `${sub.name}_${subSkill.id}`,
        name: `${sub.name}: ${subSkill.name}`,
        description: subSkill.description,
        tags: [`sub_agent:${sub.name}`, ...subSkill.tags],
      };
      result.push(skill);
    }
  }

  return result;
}

async function buildLLMAgentSkills(agent: LlmAgent): Promise<AgentSkill[]> {
  const skills: AgentSkill[] = [
    {
      id: agent.name,
      name: 'model',
      description: await buildDescriptionFromInstructions(agent),
      tags: ['llm'],
    },
  ];

  if (agent.tools && agent.tools.length > 0) {
    for (const toolUnion of agent.tools) {
      if (isBaseTool(toolUnion)) {
        skills.push(toolToSkill(agent.name, toolUnion));
      } else if (isBaseToolset(toolUnion)) {
        const tools = await toolUnion.getToolsWithPrefix();

        for (const tool of tools) {
          skills.push(toolToSkill(agent.name, tool));
        }
      }
    }
  }

  return skills;
}

function toolToSkill(prefix: string, tool: BaseTool): AgentSkill {
  let description = tool.description;
  if (!description) {
    description = `Tool: ${tool.name}`;
  }

  return {
    id: `${prefix}-${tool.name}`,
    name: tool.name,
    description: description,
    tags: ['llm', 'tools'],
  };
}

function buildNonLLMAgentSkills(agent: BaseAgent): AgentSkill[] {
  const skills: AgentSkill[] = [
    {
      id: agent.name,
      name: getAgentSkillName(agent),
      description: buildAgentDescription(agent),
      tags: [getAgentTypeTag(agent)],
    },
  ];

  const subAgents = agent.subAgents;
  if (subAgents.length > 0) {
    const descriptions = subAgents.map(
      (sub) => sub.description || 'No description',
    );
    skills.push({
      id: `${agent.name}-sub-agents`,
      name: 'sub-agents',
      description: `Orchestrates: ${descriptions.join('; ')}`,
      tags: [getAgentTypeTag(agent), 'orchestration'],
    });
  }

  return skills;
}

function buildAgentDescription(agent: BaseAgent): string {
  const descriptionParts: string[] = [];

  if (agent.description) {
    descriptionParts.push(agent.description);
  }

  if (agent.subAgents.length > 0) {
    if (isLoopAgent(agent)) {
      descriptionParts.push(buildLoopAgentDescription(agent));
    } else if (isParallelAgent(agent)) {
      descriptionParts.push(buildParallelAgentDescription(agent));
    } else if (isSequentialAgent(agent)) {
      descriptionParts.push(buildSequentialAgentDescription(agent));
    }
  }

  if (descriptionParts.length > 0) {
    return descriptionParts.join(' ');
  } else {
    return getDefaultAgentDescription(agent);
  }
}

function buildSequentialAgentDescription(agent: BaseAgent): string {
  const subAgents = agent.subAgents;
  const descriptions: string[] = [];

  subAgents.forEach((sub, i) => {
    let subDescription = sub.description;
    if (!subDescription) {
      subDescription = `execute the ${sub.name} agent`;
    }

    if (i === 0) {
      descriptions.push(`First, this agent will ${subDescription}.`);
    } else if (i === subAgents.length - 1) {
      descriptions.push(`Finally, this agent will ${subDescription}.`);
    } else {
      descriptions.push(`Then, this agent will ${subDescription}.`);
    }
  });

  return descriptions.join(' ');
}

function buildParallelAgentDescription(agent: BaseAgent): string {
  const subAgents = agent.subAgents;
  const descriptions: string[] = [];

  subAgents.forEach((sub, i) => {
    let subDescription = sub.description;
    if (!subDescription) {
      subDescription = `execute the ${sub.name} agent`;
    }

    if (i === 0) {
      descriptions.push(`This agent will ${subDescription}`);
    } else if (i === subAgents.length - 1) {
      descriptions.push(`and ${subDescription}`);
    } else {
      descriptions.push(`, ${subDescription}`);
    }
  });

  return `${descriptions.join(' ')} simultaneously.`;
}

function buildLoopAgentDescription(agent: LoopAgent): string {
  const maxIterationsVal = agent.maxIterations;
  let maxIterations = 'unlimited';
  if (
    typeof maxIterationsVal === 'number' &&
    maxIterationsVal < Number.MAX_SAFE_INTEGER
  ) {
    maxIterations = maxIterationsVal.toString();
  }

  const subAgents = agent.subAgents;
  const descriptions: string[] = [];

  subAgents.forEach((sub, i) => {
    let subDescription = sub.description;
    if (!subDescription) {
      subDescription = `execute the ${sub.name} agent`;
    }

    if (i === 0) {
      descriptions.push(`This agent will ${subDescription}`);
    } else if (i === subAgents.length - 1) {
      descriptions.push(`and ${subDescription}`);
    } else {
      descriptions.push(`, ${subDescription}`);
    }
  });

  return `${descriptions.join(' ')} in a loop (max ${maxIterations} iterations).`;
}

async function buildDescriptionFromInstructions(
  agent: LlmAgent,
): Promise<string> {
  const descriptionParts: string[] = [];
  if (agent.description) {
    descriptionParts.push(agent.description);
  }

  if (agent.instruction) {
    let instructionStr: string;
    if (typeof agent.instruction === 'function') {
      const dummyContext = new ReadonlyContext(
        new InvocationContext({
          agent: agent,
        } as unknown as InvocationContextParams),
      );
      try {
        instructionStr = await agent.instruction(dummyContext);
      } catch (e) {
        logger.warn('Failed to resolve dynamic instruction for AgentCard', e);
        instructionStr = '';
      }
    } else {
      instructionStr = agent.instruction;
    }

    if (instructionStr) {
      descriptionParts.push(replacePronouns(instructionStr));
    }
  }

  const root = agent.rootAgent;
  if (isLlmAgent(root) && root.globalInstruction) {
    let globalInstructionStr: string;
    if (typeof root.globalInstruction === 'function') {
      const dummyContext = new ReadonlyContext(
        new InvocationContext({
          agent: agent,
        } as unknown as InvocationContextParams),
      );
      try {
        globalInstructionStr = await root.globalInstruction(dummyContext);
      } catch (e) {
        logger.warn(
          'Failed to resolve dynamic global instruction for AgentCard',
          e,
        );
        globalInstructionStr = '';
      }
    } else {
      globalInstructionStr = root.globalInstruction;
    }

    if (globalInstructionStr) {
      descriptionParts.push(replacePronouns(globalInstructionStr));
    }
  }

  if (descriptionParts.length > 0) {
    return descriptionParts.join(' ');
  } else {
    return getDefaultAgentDescription(agent);
  }
}

// Replaces pronouns and conjugate common verbs for agent description.
// Examples: "You are" -> "I am", "your" -> "my"
function replacePronouns(instruction: string): string {
  const substitutions = [
    {original: 'you were', target: 'I was'},
    {original: 'you are', target: 'I am'},
    {original: "you're", target: 'I am'},
    {original: "you've", target: 'I have'},
    {original: 'yours', target: 'mine'},
    {original: 'your', target: 'my'},
    {original: 'you', target: 'I'},
  ];

  let result = instruction;
  for (const sub of substitutions) {
    // Only replace whole words, case insensitive
    const pattern = new RegExp(`\\b${sub.original}\\b`, 'gi');
    result = result.replace(pattern, sub.target);
  }
  return result;
}

function getDefaultAgentDescription(agent: BaseAgent): string {
  if (isLoopAgent(agent)) {
    return 'A loop workflow agent';
  } else if (isSequentialAgent(agent)) {
    return 'A sequential workflow agent';
  } else if (isParallelAgent(agent)) {
    return 'A parallel workflow agent';
  } else if (isLlmAgent(agent)) {
    return 'An LLM-based agent';
  } else {
    return 'A custom agent';
  }
}

function getAgentTypeTag(agent: BaseAgent): string {
  if (isLoopAgent(agent)) {
    return 'loop_workflow';
  } else if (isSequentialAgent(agent)) {
    return 'sequential_workflow';
  } else if (isParallelAgent(agent)) {
    return 'parallel_workflow';
  } else if (isLlmAgent(agent)) {
    return 'llm_agent';
  } else {
    return 'custom_agent';
  }
}

function getAgentSkillName(agent: BaseAgent): string {
  if (isLlmAgent(agent)) {
    return 'model';
  }
  if (isCompositeShellAgent(agent) || isWorkflow(agent)) {
    return 'workflow';
  }
  return 'custom';
}

function isCompositeShellAgent(agent: BaseAgent): boolean {
  return (
    isLoopAgent(agent) || isSequentialAgent(agent) || isParallelAgent(agent)
  );
}
