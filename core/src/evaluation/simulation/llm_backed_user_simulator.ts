/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';

import {InputValidationError} from '../../errors/input_validation_error.js';
import type {Event} from '../../events/event.js';
import type {BaseLlm} from '../../models/base_llm.js';
import type {LlmRequest} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import type {ConversationScenario} from '../conversation_scenarios.js';
import {addDefaultRetryOptionsIfNotPresent} from '../retry_options_utils.js';

import {
  getLlmBackedUserSimulatorPrompt,
  isValidUserSimulatorTemplate,
  REQUIRED_TEMPLATE_PARAMS,
} from './llm_backed_user_simulator_prompts.js';
import {
  UserSimulatorStatus,
  type NextUserMessage,
  type UserSimulator,
} from './user_simulator.js';
import type {UserPersona} from './user_simulator_personas.js';

const AUTHOR_USER = 'user';

/** The text the model writes when it decides the conversation is over. */
const STOP_SIGNAL = '</finished>';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_MAX_ALLOWED_INVOCATIONS = 20;
const DEFAULT_THINKING_BUDGET = 10240;

const CUSTOM_INSTRUCTIONS_ERROR =
  'custom_instructions must contain each of the following formatting' +
  ' placeholders using Jinja syntax: {{ stop_signal }},' +
  ' {{ conversation_plan }}, {{ conversation_history }}';

/**
 * Builds the model configuration a simulator uses when its config omits one.
 *
 * A factory and not a shared constant, because
 * {@link addDefaultRetryOptionsIfNotPresent} writes the retry policy into the
 * configuration object it is given. One shared object would carry one
 * simulator's retry policy into every other simulator that took the default.
 */
function defaultModelConfiguration(): GenerateContentConfig {
  return {
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: DEFAULT_THINKING_BUDGET,
    },
  };
}

/** Settings of an {@link LlmBackedUserSimulator}. */
export interface LlmBackedUserSimulatorConfig {
  /** The model that writes the user's messages. Defaults to a Gemini Flash. */
  model?: string;

  /**
   * The configuration of {@link LlmBackedUserSimulatorConfig.model}. Defaults
   * to a thinking configuration that returns the model's thoughts.
   */
  modelConfiguration?: GenerateContentConfig;

  /**
   * The invocations one simulated conversation may run, the opening prompt
   * included. It ends a conversation in which the agent and the simulated user
   * answer each other forever. A value of `-1` removes the limit, which is not
   * recommended. Defaults to 20.
   */
  maxAllowedInvocations?: number;

  /**
   * Instructions that replace the built-in simulator prompt. They must read
   * the `stop_signal`, `conversation_plan` and `conversation_history` Jinja
   * placeholders, and also `persona` when the scenario names a persona.
   */
  customInstructions?: string;

  /**
   * Whether the conversation history the simulator reads includes the agent's
   * function calls and function responses. Defaults to `false`.
   */
  includeFunctionCalls?: boolean;
}

/**
 * Rewrites a conversation as the plain dialogue the simulator's prompt shows.
 *
 * The agent's thoughts are dropped, because the simulated user plays a person
 * who never saw them.
 *
 * @param events The conversation to rewrite.
 * @param includeFunctionCalls Whether to keep the agent's function calls and
 *   function responses.
 * @returns The dialogue, one turn per paragraph.
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
    for (const part of parts) {
      if (part.text && !part.thought) {
        rewrittenDialogue.push(`${event.author}: ${part.text}`);
      } else if (includeFunctionCalls && part.functionCall) {
        rewrittenDialogue.push(
          `${event.author} called tool '${part.functionCall.name}' with args:` +
            ` ${JSON.stringify(part.functionCall.args ?? null)}`,
        );
      } else if (includeFunctionCalls && part.functionResponse) {
        rewrittenDialogue.push(
          `Tool '${part.functionResponse.name}' returned:` +
            ` ${JSON.stringify(part.functionResponse.response ?? null)}`,
        );
      }
    }
  }
  return rewrittenDialogue.join('\n\n');
}

/** What one model call produced: the message, or why there is none. */
interface GeneratedMessage {
  /** The message the model wrote. Empty when the model wrote none. */
  response: string;

  /** Why {@link GeneratedMessage.response} is empty. */
  errorReason?: string;
}

/**
 * Plays the user side of an eval case with a model that follows a conversation
 * plan.
 *
 * The scenario supplies a goal rather than a script, so the simulated user can
 * answer the agent's questions, correct it, and end the conversation once the
 * plan is complete.
 */
@experimental
export class LlmBackedUserSimulator implements UserSimulator {
  private readonly model: string;
  private readonly modelConfiguration: GenerateContentConfig;
  private readonly maxAllowedInvocations: number;
  private readonly customInstructions?: string;
  private readonly includeFunctionCalls: boolean;
  private readonly conversationScenario: ConversationScenario;
  private readonly userPersona?: UserPersona;
  private readonly llm: BaseLlm;
  private invocationCount = 0;

  /**
   * @param params.config The settings of the simulator.
   * @param params.conversationScenario The goal the simulated user pursues.
   * @param params.llm The model to ask. Defaults to the model the config
   *   names, resolved through {@link LLMRegistry}. Pass one to run a simulated
   *   conversation against a model of your own.
   * @throws {InputValidationError} When `config.customInstructions` omits a
   *   required placeholder.
   */
  constructor(params: {
    config: LlmBackedUserSimulatorConfig;
    conversationScenario: ConversationScenario;
    llm?: BaseLlm;
  }) {
    const {config, conversationScenario, llm} = params;
    if (
      config.customInstructions !== undefined &&
      !isValidUserSimulatorTemplate(
        config.customInstructions,
        REQUIRED_TEMPLATE_PARAMS,
      )
    ) {
      throw new InputValidationError(CUSTOM_INSTRUCTIONS_ERROR);
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.modelConfiguration =
      config.modelConfiguration ?? defaultModelConfiguration();
    this.maxAllowedInvocations =
      config.maxAllowedInvocations ?? DEFAULT_MAX_ALLOWED_INVOCATIONS;
    this.customInstructions = config.customInstructions;
    this.includeFunctionCalls = config.includeFunctionCalls ?? false;
    this.conversationScenario = conversationScenario;
    this.userPersona = conversationScenario.userPersona;
    this.llm = llm ?? LLMRegistry.newLlm(this.model);
  }

  /**
   * Returns the next user message.
   *
   * The first call returns the scenario's starting prompt and asks no model.
   *
   * @param events The conversation so far, unaltered.
   * @returns The next user message, or a status explaining why there is none.
   * @throws {Error} When the model produced no message. adk-python throws here
   *   too: an LLM-backed simulator that cannot write a turn is a failed run,
   *   not a conversation that ended.
   */
  async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    if (
      this.maxAllowedInvocations >= 0 &&
      this.invocationCount >= this.maxAllowedInvocations
    ) {
      logger.warn(
        `LlmBackedUserSimulator invocation limit (${this.maxAllowedInvocations}) reached!`,
      );
      return {status: UserSimulatorStatus.TURN_LIMIT_REACHED};
    }

    const {response, errorReason} = await this.generateMessage(
      summarizeConversation(events, this.includeFunctionCalls),
    );
    this.invocationCount++;

    if (response.toLowerCase().includes(STOP_SIGNAL)) {
      logger.debug(
        'Stopping user message generation as the stop signal was detected.',
      );
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    if (response) {
      return {
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {parts: [{text: response}], role: AUTHOR_USER},
      };
    }
    throw new Error(`Failed to generate a user message: ${errorReason}`);
  }

  /** Asks the model for the next user message. */
  private async generateMessage(
    conversationHistory: string,
  ): Promise<GeneratedMessage> {
    if (this.invocationCount === 0) {
      return {response: this.conversationScenario.startingPrompt};
    }

    const llmRequest: LlmRequest = {
      model: this.model,
      config: this.modelConfiguration,
      contents: [
        {
          parts: [
            {
              text: getLlmBackedUserSimulatorPrompt({
                conversationPlan: this.conversationScenario.conversationPlan,
                conversationHistory,
                stopSignal: STOP_SIGNAL,
                customInstructions: this.customInstructions,
                userPersona: this.userPersona,
              }),
            },
          ],
          role: AUTHOR_USER,
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    let response = '';
    let hasThoughtTokens = false;
    for await (const llmResponse of this.llm.generateContentAsync(llmRequest)) {
      if (llmResponse.errorCode) {
        logger.warn(
          `User simulator LLM returned error: code=${llmResponse.errorCode},` +
            ` message=${llmResponse.errorMessage ?? ''}`,
        );
        return {
          response: '',
          errorReason: `safety filters or other error (code=${llmResponse.errorCode})`,
        };
      }
      for (const part of llmResponse.content?.parts ?? []) {
        if (part.thought) {
          hasThoughtTokens = true;
        } else if (part.text) {
          response += part.text;
        }
      }
    }

    if (response) {
      return {response};
    }
    return {
      response: '',
      errorReason: hasThoughtTokens
        ? 'LLM returned only thinking tokens'
        : 'LLM returned empty response',
    };
  }
}
