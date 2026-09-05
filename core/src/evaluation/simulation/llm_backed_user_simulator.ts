/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, Part} from '@google/genai';
import {z} from 'zod';

import {InputValidationError} from '../../errors/input_validation_error.js';
import {Event} from '../../events/event.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {toCamelCase} from '../../utils/object_notation_utils.js';
import {ConversationScenario} from '../conversation_scenarios.js';
import {addDefaultRetryOptionsIfNotPresent} from '../retry_options_utils.js';
import {
  REQUIRED_TEMPLATE_PARAMS,
  getLlmBackedUserSimulatorPrompt,
  isValidUserSimulatorTemplate,
} from './llm_backed_user_simulator_prompts.js';
import {
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
} from './user_simulator.js';

/**
 * The signal a simulated user emits when the conversation is complete.
 *
 * adk-python keeps this module-private too. The evaluation metrics module
 * exports the same constant for a metric criterion to default to, but that
 * module is not part of this change.
 */
const DEFAULT_USER_SIMULATOR_STOP_SIGNAL = '</finished>';

/** The model that plays the user when the config names none. */
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** The turn budget one simulated conversation gets when the config sets none. */
const DEFAULT_MAX_ALLOWED_INVOCATIONS = 20;

/** Thinking tokens the default model configuration allows per turn. */
const DEFAULT_THINKING_BUDGET = 10240;

/** The role every message this simulator produces carries. */
const USER_ROLE = 'user';

/**
 * Author used for an event that names none. adk-python's `Event.author` is
 * required, so it has no such case; adk-js declares the field optional.
 * `evaluation_generator` labels the same events the same way.
 */
const DEFAULT_AUTHOR = 'agent';

const CUSTOM_INSTRUCTIONS_ERROR =
  'custom_instructions must contain each of the following formatting' +
  ' placeholders using Jinja syntax: {{ stop_signal }}, {{' +
  ' conversation_plan }}, {{ conversation_history }}';

const configSchema = z.strictObject({
  /** Discriminator that selects this simulator. */
  type: z.literal('llm_backed').default('llm_backed'),

  /** The model that plays the user. */
  model: z.string().default(DEFAULT_MODEL),

  /** The configuration the model is called with. */
  modelConfiguration: z
    .custom<GenerateContentConfig>(
      (value) => typeof value === 'object' && value !== null,
      {message: 'must be a GenerateContentConfig'},
    )
    // A fresh object per config, so one simulator's model configuration is
    // never the object another simulator reads.
    .default(() => ({
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: DEFAULT_THINKING_BUDGET,
      },
    })),

  /**
   * How many turns the simulated conversation may take, the fixed starting
   * prompt included. It stops a run-away conversation in which the agent and
   * the simulated user never finish. `-1` removes the limit, which is not
   * recommended.
   */
  maxAllowedInvocations: z.number().default(DEFAULT_MAX_ALLOWED_INVOCATIONS),

  /** Instructions that replace the built-in ones. */
  customInstructions: z
    .string()
    .refine(
      (value) => isValidUserSimulatorTemplate(value, REQUIRED_TEMPLATE_PARAMS),
      {message: CUSTOM_INSTRUCTIONS_ERROR},
    )
    // adk-python writes `null` for a field it has no value for.
    .nullish()
    .transform((value) => value ?? undefined),

  /**
   * Whether the conversation the model is shown includes the agent's tool
   * calls and their results.
   */
  includeFunctionCalls: z.boolean().default(false),
});

/**
 * A {@link LlmBackedUserSimulatorConfig} with every default applied, as
 * {@link parseLlmBackedUserSimulatorConfig} returns it.
 */
export interface ResolvedLlmBackedUserSimulatorConfig {
  /** Discriminator that selects this simulator. Defaults to `'llm_backed'`. */
  type: 'llm_backed';

  /** The model that plays the user. Defaults to `'gemini-2.5-flash'`. */
  model: string;

  /**
   * The configuration the model is called with. Defaults to a thinking budget
   * of 10240 tokens, with thoughts included.
   */
  modelConfiguration: GenerateContentConfig;

  /**
   * How many turns the simulated conversation may take, the fixed starting
   * prompt included. It stops a run-away conversation in which the agent and
   * the simulated user never finish. Defaults to 20. Set `-1` for no limit,
   * which is not recommended.
   */
  maxAllowedInvocations: number;

  /**
   * Instructions that replace the built-in ones. They must reference
   * `{{ stop_signal }}`, `{{ conversation_plan }}` and
   * `{{ conversation_history }}`, and also `{{ persona }}` when the scenario
   * names a persona. Absent by default.
   */
  customInstructions?: string;

  /**
   * Whether the conversation the model is shown includes the agent's tool
   * calls and their results. Defaults to false.
   */
  includeFunctionCalls: boolean;
}

/**
 * Configuration for {@link LlmBackedUserSimulator}.
 *
 * Every field has a default, which {@link parseLlmBackedUserSimulatorConfig}
 * applies.
 */
export type LlmBackedUserSimulatorConfig =
  Partial<ResolvedLlmBackedUserSimulatorConfig>;

/**
 * `modelConfiguration`, under either spelling, so
 * {@link parseLlmBackedUserSimulatorConfig} hands it to the model as the
 * caller wrote it. `toCamelCase` matches these against the key it reads, and
 * rebuilds every object it does not preserve — which would rewrite the keys of
 * `labels` and of a response schema, and flatten an `AbortSignal` into a plain
 * object.
 */
const OPAQUE_CONFIG_KEYS = ['modelConfiguration', 'model_configuration'];

/**
 * Validates a user simulator config and applies its defaults.
 *
 * Accepts the snake_case spelling adk-python writes as well as the canonical
 * camelCase one. `modelConfiguration` is opaque: it reaches the model exactly
 * as given, so its own keys keep whatever spelling the caller used.
 *
 * @param raw The config document to validate.
 * @returns The config, with every default applied.
 * @throws {InputValidationError} If the document is not a valid config.
 */
export function parseLlmBackedUserSimulatorConfig(
  raw: unknown,
): ResolvedLlmBackedUserSimulatorConfig {
  const result = configSchema.safeParse(toCamelCase(raw, OPAQUE_CONFIG_KEYS));
  if (!result.success) {
    throw new InputValidationError(
      `Invalid LlmBackedUserSimulatorConfig: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Renders one part of the conversation as the simulated user sees it.
 *
 * @param part The part to render.
 * @param author The author of the event the part belongs to.
 * @param includeFunctionCalls Whether tool calls and results are rendered.
 * @returns The rendered line, or `undefined` when the part is not shown.
 */
function describePart(
  part: Part,
  author: string,
  includeFunctionCalls: boolean,
): string | undefined {
  if (part.text && !part.thought) {
    return `${author}: ${part.text}`;
  }
  if (!includeFunctionCalls) {
    return undefined;
  }
  if (part.functionCall) {
    return (
      `${author} called tool '${part.functionCall.name}' with args:` +
      ` ${JSON.stringify(part.functionCall.args)}`
    );
  }
  if (part.functionResponse) {
    return (
      `Tool '${part.functionResponse.name}' returned:` +
      ` ${JSON.stringify(part.functionResponse.response)}`
    );
  }
  return undefined;
}

/**
 * Summarizes a conversation for the simulated user's prompt.
 *
 * Drops the agent's thoughts, and drops its tool calls and results unless
 * `includeFunctionCalls` asks for them.
 *
 * @param events The conversation to summarize.
 * @param includeFunctionCalls Whether tool calls and results are included.
 * @returns The conversation as one string, a blank line between turns.
 */
export function summarizeConversation(
  events: Event[],
  includeFunctionCalls = false,
): string {
  const lines: string[] = [];
  for (const event of events) {
    const author = event.author ?? DEFAULT_AUTHOR;
    for (const part of event.content?.parts ?? []) {
      const line = describePart(part, author, includeFunctionCalls);
      if (line !== undefined) {
        lines.push(line);
      }
    }
  }
  return lines.join('\n\n');
}

/** What one model call produced, or why it produced nothing. */
interface SimulatedUserResponse {
  /** The text the model returned. Empty when the call produced none. */
  response: string;

  /** Why the response is empty. Absent while the response is not. */
  errorReason?: string;
}

/** Options for {@link LlmBackedUserSimulator}. */
export interface LlmBackedUserSimulatorOptions {
  /** How the simulated user is configured. */
  config: LlmBackedUserSimulatorConfig;

  /** The scenario the simulated user plays out. */
  conversationScenario: ConversationScenario;

  /**
   * The model that plays the user. Resolved from `LLMRegistry` when absent.
   */
  llm?: BaseLlm;
}

/**
 * A {@link UserSimulator} that asks a model what the user says next.
 *
 * The first turn is the scenario's starting prompt and costs no model call.
 * Every later turn summarizes the conversation so far and asks the model to
 * continue it, until the plan is satisfied, the model emits the stop signal,
 * or the turn budget runs out.
 */
@experimental
export class LlmBackedUserSimulator implements UserSimulator {
  private readonly config: ResolvedLlmBackedUserSimulatorConfig;
  private readonly conversationScenario: ConversationScenario;
  private readonly llm: BaseLlm;
  private invocationCount = 0;

  constructor(options: LlmBackedUserSimulatorOptions) {
    this.config = parseLlmBackedUserSimulatorConfig(options.config);
    this.conversationScenario = options.conversationScenario;
    this.llm = options.llm ?? LLMRegistry.newLlm(this.config.model);
  }

  /**
   * Asks the model for the next user message.
   *
   * @param conversationHistory The conversation so far, already summarized.
   * @returns The text the model produced, or the reason it produced none.
   */
  private async getLlmResponse(
    conversationHistory: string,
  ): Promise<SimulatedUserResponse> {
    if (this.invocationCount === 0) {
      return {response: this.conversationScenario.startingPrompt};
    }

    const instructions = getLlmBackedUserSimulatorPrompt({
      conversationPlan: this.conversationScenario.conversationPlan,
      conversationHistory,
      stopSignal: DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
      customInstructions: this.config.customInstructions,
      userPersona: this.conversationScenario.userPersona,
    });

    const llmRequest: LlmRequest = {
      // The model that answers, not the one the config names: `Gemini` binds
      // the outgoing call to `llmRequest.model` ahead of its own, so a
      // caller-supplied model would otherwise be sent to the wrong model.
      model: this.llm.model,
      contents: [{role: USER_ROLE, parts: [{text: instructions}]}],
      config: this.config.modelConfiguration,
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    let response = '';
    let errorReason: string | undefined;
    let hasThoughtTokens = false;
    for await (const llmResponse of this.llm.generateContentAsync(llmRequest)) {
      if (llmResponse.errorCode) {
        logger.warn(
          `User simulator LLM returned error: code=${llmResponse.errorCode},` +
            ` message=${llmResponse.errorMessage ?? ''}`,
        );
        errorReason = `safety filters or other error (code=${llmResponse.errorCode})`;
        response = '';
        break;
      }
      for (const part of llmResponse.content?.parts ?? []) {
        if (part.thought) {
          hasThoughtTokens = true;
        } else if (part.text) {
          response += part.text;
        }
      }
    }

    if (!response) {
      errorReason ??= hasThoughtTokens
        ? 'LLM returned only thinking tokens'
        : 'LLM returned empty response';
    }
    return {response, errorReason};
  }

  /**
   * Returns the next user message to send to the agent.
   *
   * @param events The unaltered conversation between the user and the agents
   *     under evaluation.
   * @returns The next user message, or a status explaining why there is none.
   * @throws {Error} If the model produced no message. That is a failure of the
   *     model, not an outcome of the simulation.
   */
  async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    const invocationLimit = this.config.maxAllowedInvocations;
    if (invocationLimit >= 0 && this.invocationCount >= invocationLimit) {
      logger.warn(
        `LlmBackedUserSimulator invocation limit (${invocationLimit}) reached!`,
      );
      return {status: UserSimulatorStatus.TURN_LIMIT_REACHED};
    }

    const conversationHistory = summarizeConversation(
      events,
      this.config.includeFunctionCalls,
    );
    const {response, errorReason} =
      await this.getLlmResponse(conversationHistory);
    this.invocationCount++;

    if (
      response
        .toLowerCase()
        .includes(DEFAULT_USER_SIMULATOR_STOP_SIGNAL.toLowerCase())
    ) {
      logger.debug(
        'Stopping user message generation as the stop signal was detected.',
      );
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }

    if (response) {
      return {
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {role: USER_ROLE, parts: [{text: response}]},
      };
    }

    throw new Error(`Failed to generate a user message: ${errorReason}`);
  }
}
