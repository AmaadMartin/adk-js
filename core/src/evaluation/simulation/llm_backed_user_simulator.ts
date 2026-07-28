/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {Event} from '../../events/event.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {addDefaultRetryOptionsIfNotPresent} from '../_retry_options_utils.js';
import {ConversationScenario} from '../conversation_scenarios.js';
import {Evaluator} from '../eval_case.js';
import {
  getLlmBackedUserSimulatorPrompt,
  isValidUserSimulatorTemplate,
} from './llm_backed_user_simulator_prompts.js';
import {
  BaseUserSimulatorConfig,
  NextUserMessage,
  Status,
  UserSimulator,
} from './user_simulator.js';
import {UserPersona} from './user_simulator_personas.js';

const AUTHOR_USER = 'user';
const STOP_SIGNAL = '</finished>';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_MAX_ALLOWED_INVOCATIONS = 20;

/** Initializer for an {@link LlmBackedUserSimulatorConfig}. */
export interface LlmBackedUserSimulatorConfigInit {
  /** Discriminator; locked to `'llm_backed'`. */
  type?: 'llm_backed';
  /** The model to use for user simulation. */
  model?: string;
  /** The configuration for the model. */
  modelConfiguration?: GenerateContentConfig;
  /** Maximum number of invocations allowed (`-1` disables the limit). */
  maxAllowedInvocations?: number;
  /** Custom instruction template (must contain the required placeholders). */
  customInstructions?: string;
  /** Whether to include function calls/responses in the history prompt. */
  includeFunctionCalls?: boolean;
}

/**
 * Configuration for an {@link LlmBackedUserSimulator}.
 */
export class LlmBackedUserSimulatorConfig extends BaseUserSimulatorConfig {
  /** Discriminator tag for this config subclass. */
  declare type: 'llm_backed';

  /** The model to use for user simulation. */
  model: string;

  /** The configuration for the model. */
  modelConfiguration: GenerateContentConfig;

  /**
   * Maximum number of invocations allowed by the simulated interaction. The
   * initial fixed prompt is counted as an invocation. Set to `-1` to disable
   * the limit (not recommended).
   */
  maxAllowedInvocations: number;

  /**
   * Custom instructions for the simulator. Must contain the Jinja placeholders
   * `{{ stop_signal }}`, `{{ conversation_plan }}`, `{{ conversation_history }}`
   * (and `{{ persona }}` when a persona is used).
   */
  customInstructions?: string;

  /**
   * Whether to include function calls and responses in the conversation-history
   * prompt provided to the user simulator.
   */
  includeFunctionCalls: boolean;

  /**
   * Creates an `LlmBackedUserSimulatorConfig`.
   *
   * @param data The config fields (or a base config to promote).
   * @throws {Error} If `type` is not `'llm_backed'`, or `customInstructions` is
   *     set but missing the required placeholders.
   */
  constructor(
    data: LlmBackedUserSimulatorConfigInit | BaseUserSimulatorConfig = {},
  ) {
    super(data);
    const input = data as LlmBackedUserSimulatorConfigInit;
    if (input.type !== undefined && input.type !== 'llm_backed') {
      throw new Error("`type` must be 'llm_backed'.");
    }
    if (
      input.customInstructions !== undefined &&
      !isValidUserSimulatorTemplate(input.customInstructions, [
        'stop_signal',
        'conversation_plan',
        'conversation_history',
      ])
    ) {
      throw new Error(
        'custom_instructions must contain each of the following formatting' +
          ' placeholders using Jinja syntax: {{ stop_signal }}, {{' +
          ' conversation_plan }}, {{ conversation_history }}',
      );
    }
    this.type = 'llm_backed';
    this.model = input.model ?? DEFAULT_MODEL;
    this.modelConfiguration = input.modelConfiguration ?? {
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    };
    this.maxAllowedInvocations =
      input.maxAllowedInvocations ?? DEFAULT_MAX_ALLOWED_INVOCATIONS;
    this.customInstructions = input.customInstructions;
    this.includeFunctionCalls = input.includeFunctionCalls ?? false;
  }
}

/**
 * Formats a tool-call argument or response value in a Python-repr-like style.
 *
 * Reproduces the specific renderings the reference tests assert (`None` for an
 * absent value, `{'name': 'John Doe'}` for a dict). Numbers and lists follow
 * the same style; other primitive types fall back to `String()`.
 */
function formatToolValue(value: unknown): string {
  if (value === undefined || value === null) {
    return 'None';
  }
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatToolValue).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, val]) => `'${key}': ${formatToolValue(val)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}

/**
 * Summarizes a conversation for the user-simulator prompt.
 *
 * Removes agent thoughts; keeps text turns; optionally includes tool calls and
 * responses. Ported as a standalone module function (the adk-python
 * `_summarize_conversation` classmethod uses no instance identity).
 *
 * @param events The conversation history to rewrite.
 * @param includeFunctionCalls Whether to include function calls and responses.
 * @returns The summarized conversation history.
 */
export function summarizeConversation(
  events: Event[],
  includeFunctionCalls = false,
): string {
  const rewrittenDialogue: string[] = [];
  for (const event of events) {
    const parts = event.content?.parts;
    if (!parts) {
      continue;
    }
    const author = event.author;
    for (const part of parts) {
      if (part.text && !part.thought) {
        rewrittenDialogue.push(`${author}: ${part.text}`);
      } else if (includeFunctionCalls && part.functionCall) {
        rewrittenDialogue.push(
          `${author} called tool '${part.functionCall.name}' with args:` +
            ` ${formatToolValue(part.functionCall.args)}`,
        );
      } else if (includeFunctionCalls && part.functionResponse) {
        rewrittenDialogue.push(
          `Tool '${part.functionResponse.name}' returned:` +
            ` ${formatToolValue(part.functionResponse.response)}`,
        );
      }
    }
  }
  return rewrittenDialogue.join('\n\n');
}

/**
 * A {@link UserSimulator} that uses an LLM to generate user messages.
 */
@experimental
export class LlmBackedUserSimulator extends UserSimulator {
  /** The resolved configuration for this simulator. */
  readonly config: LlmBackedUserSimulatorConfig;

  /** The conversation scenario driving this simulator. */
  readonly conversationScenario: ConversationScenario;

  private readonly llm: BaseLlm;
  private readonly userPersona?: UserPersona;
  private invocationCount = 0;

  /**
   * Creates an `LlmBackedUserSimulator`. The supplied config is promoted to the
   * concrete `LlmBackedUserSimulatorConfig` type, and the scenario drives the
   * simulated conversation.
   */
  constructor({
    config,
    conversationScenario,
  }: {
    config: BaseUserSimulatorConfig;
    conversationScenario: ConversationScenario;
  }) {
    super();
    this.config = new LlmBackedUserSimulatorConfig(config);
    this.conversationScenario = conversationScenario;
    this.llm = LLMRegistry.newLlm(this.config.model);
    this.userPersona = conversationScenario.userPersona;
  }

  private async getLlmResponse(
    rewrittenDialogue: string,
  ): Promise<[string, string | undefined]> {
    if (this.invocationCount === 0) {
      return [this.conversationScenario.startingPrompt, undefined];
    }

    const userAgentInstructions = getLlmBackedUserSimulatorPrompt({
      conversationPlan: this.conversationScenario.conversationPlan,
      conversationHistory: rewrittenDialogue,
      stopSignal: STOP_SIGNAL,
      customInstructions: this.config.customInstructions,
      userPersona: this.userPersona,
    });

    const llmRequest: LlmRequest = {
      model: this.config.model,
      config: this.config.modelConfiguration,
      contents: [{parts: [{text: userAgentInstructions}], role: AUTHOR_USER}],
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    let response = '';
    let errorReason: string | undefined;
    let hasThoughtTokens = false;
    for await (const llmResponse of this.llm.generateContentAsync(llmRequest)) {
      const errorCode = llmResponse.errorCode;
      if (errorCode) {
        logger.warn(
          `User simulator LLM returned error: code=${errorCode}, message=` +
            `${llmResponse.errorMessage ?? ''}`,
        );
        errorReason = `safety filters or other error (code=${errorCode})`;
        response = '';
        break;
      }

      const parts = llmResponse.content?.parts;
      if (!parts) {
        continue;
      }
      for (const part of parts) {
        if (part.thought) {
          hasThoughtTokens = true;
        } else if (part.text) {
          response += part.text;
        }
      }
    }

    if (!response && errorReason === undefined) {
      errorReason = hasThoughtTokens
        ? 'LLM returned only thinking tokens'
        : 'LLM returned empty response';
    }

    return [response, errorReason];
  }

  /**
   * Returns the next user message, generated with help from the LLM. The first
   * invocation returns the scenario's starting prompt without calling the model.
   *
   * @param events The unaltered conversation history.
   * @returns The next user message or a status explaining why none was
   *     generated.
   * @throws {Error} If the user message could not be generated.
   */
  override async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    const invocationLimit = this.config.maxAllowedInvocations;
    if (invocationLimit >= 0 && this.invocationCount >= invocationLimit) {
      logger.warn(
        `LlmBackedUserSimulator invocation limit (${invocationLimit})` +
          ' reached!',
      );
      return new NextUserMessage({status: Status.TURN_LIMIT_REACHED});
    }

    const rewrittenDialogue = summarizeConversation(
      events,
      this.config.includeFunctionCalls,
    );

    const [response, errorReason] =
      await this.getLlmResponse(rewrittenDialogue);
    this.invocationCount += 1;

    if (
      response &&
      response.toLowerCase().includes(STOP_SIGNAL.toLowerCase())
    ) {
      logger.debug(
        'Stopping user message generation as the stop signal was detected.',
      );
      return new NextUserMessage({status: Status.STOP_SIGNAL_DETECTED});
    }

    if (response) {
      return new NextUserMessage({
        status: Status.SUCCESS,
        userMessage: {parts: [{text: response}], role: AUTHOR_USER},
      });
    }

    throw new Error(`Failed to generate a user message: ${errorReason}`);
  }

  /**
   * Returns the simulation evaluator.
   *
   * @throws {Error} Always -- the concrete evaluator is a separate port.
   */
  override getSimulationEvaluator(): Evaluator | undefined {
    throw new Error('Not implemented.');
  }
}
