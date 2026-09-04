/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import nunjucks from 'nunjucks';

import {InputValidationError} from '../../errors/input_validation_error.js';
import type {UserPersona} from './user_simulator_personas.js';

/** Instructions given to a simulated user that adopts no persona. */
export const DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE = `You are a Simulated User designed to test an AI Agent.

Your single most important job is to react logically to the Agent's last message.
The Conversation Plan is your canonical grounding, not a script; your response MUST be dictated by what the Agent just said.

# Primary Operating Loop

You MUST follow this three-step process while thinking:

Step 1: Analyze what the Agent just said or did. Specifically, is the Agent asking you a question, reporting a successful or unsuccessful operation, or saying something incorrect or unexpected?

Step 2: Choose one action based on your analysis:
* ANSWER any questions the Agent asked.
* ADVANCE to the next request as per the Conversation Plan if the Agent succeeds in satisfying your current request.
* INTERVENE if the Agent is yet to complete your current request and the Conversation Plan requires you to modify it.
* CORRECT the Agent if it is making a mistake or failing.
* END the conversation if any of the below stopping conditions are met:
  - The Agent has completed all your requests from the Conversation Plan.
  - The Agent has failed to fulfill a request *more than once*.
  - The Agent has performed an incorrect operation and informs you that it is unable to correct it.
  - The Agent ends the conversation on its own by transferring you to a *human/live agent* (NOT another AI Agent).

Step 3: Formulate a response based on the chosen action and the below Action Protocols and output it.

# Action Protocols

**PROTOCOL: ANSWER**
* Only answer the Agent's questions using information from the Conversation Plan.
* Do NOT provide any additional information the Agent did not explicitly ask for.
* If you do not have the information requested by the Agent, inform the Agent. Do NOT make up information that is not in the Conversation Plan.
* Do NOT advance to the next request in the Conversation Plan.

**PROTOCOL: ADVANCE**
* Make the next request from the Conversation Plan.
* Skip redundant requests already fulfilled by the Agent.

**PROTOCOL: INTERVENE**
* Change your current request as directed by the Conversation Plan with natural phrasing.

**PROTOCOL: CORRECT**
* Challenge illogical or incorrect statements made by the Agent.
* If the Agent did an incorrect operation, ask the Agent to fix it.
* If this is the FIRST time the Agent failed to satisfy your request, ask the Agent to try again.

**PROTOCOL: END**
* End the conversation only when any of the stopping conditions are met; do NOT end prematurely.
* Output \`{{ stop_signal }}\` to indicate that the conversation with the AI Agents is over.

# Conversation Plan

{{ conversation_plan }}

# Conversation History

{{ conversation_history }}
`;

/**
 * Instructions given to a simulated user that adopts a persona.
 *
 * The template reads `persona.behaviors[].behaviorInstructionsText`, which
 * {@link getLlmBackedUserSimulatorPrompt} derives from the behavior's
 * `behaviorInstructions`. adk-python calls a `UserBehavior` method for the
 * same string; `UserBehavior` is an interface here, so the renderer supplies
 * the field instead.
 */
export const USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE = `You are a Simulated User designed to test an AI Agent.

Your single most important job is to react logically to the Agent's last message while role-playing as the given Persona.
The Conversation Plan is your canonical grounding, not a script; your response MUST be dictated by what the Agent just said.

# Persona Description

{{ persona.description }}
This persona behaves in the following ways:
{% for b in persona.behaviors %}
## {{ b.name | render_string_filter}}
{{ b.description | render_string_filter }}

Instructions:
{{ b.behaviorInstructionsText | render_string_filter }}
{% endfor %}
# Conversation Plan

{{ conversation_plan }}

# Conversation History

{{ conversation_history }}`;

/** Placeholders every set of custom instructions must reference. */
export const REQUIRED_TEMPLATE_PARAMS = [
  'stop_signal',
  'conversation_plan',
  'conversation_history',
];

/** Placeholders custom instructions must reference when a persona is used. */
export const REQUIRED_TEMPLATE_PARAMS_WITH_PERSONA = [
  ...REQUIRED_TEMPLATE_PARAMS,
  'persona',
];

const PERSONA_CUSTOM_INSTRUCTIONS_ERROR = `Custom instructions using personas must contain the following formatting placeholders following Jinja syntax:
  * {{ stop_signal }} : text to be generated when the user simulator decides that the
    conversation is over.
  * {{ conversation_plan }} : the overall plan for the conversation that the user
    simulator must follow.
  * {{ conversation_history }} : the conversation between the user and the agent so far.
  * {{ persona }} : UserPersona for the simulator to use.`;

/** Matches the body of one `{{ ... }}` or `{% ... %}` expression. */
const EXPRESSION_PATTERN = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;

/** Matches one identifier inside an expression body. */
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * The part of a nunjucks render context a filter receives as `this`.
 *
 * `@types/nunjucks` 3.2.6 types a filter as `(...args: any[]) => any` and
 * declares no context type, so the one method used here is declared locally.
 */
interface TemplateFilterContext {
  /** The variables the enclosing template is being rendered with. */
  getVariables(): Record<string, unknown>;
}

/**
 * Builds the environment the instruction templates render in.
 *
 * `render_string_filter` renders a persona's own text as a template against
 * the surrounding context, so a persona may refer to the stop signal or to the
 * conversation plan. Autoescaping is off: the output is a model prompt, not
 * HTML, and adk-python's Jinja environment does not escape either.
 */
function createTemplateEnvironment(): nunjucks.Environment {
  const environment = new nunjucks.Environment(null, {autoescape: false});
  environment.addFilter(
    'render_string_filter',
    function (this: TemplateFilterContext, value: string): string {
      if (!value) {
        return '';
      }
      return environment.renderString(value, this.getVariables());
    },
  );
  return environment;
}

/**
 * Collects the identifiers a template mentions inside its expressions.
 *
 * This over-approximates what Jinja2's `meta.find_undeclared_variables` gives
 * adk-python: a name bound by `{% for %}` and a field name such as the
 * `description` of `persona.description` are both counted. nunjucks does not
 * publish a typed parser, and the check only asks whether the author wrote a
 * placeholder at all, so the coarser answer is enough.
 *
 * @param template The template to scan.
 * @returns Every identifier that appears in an expression.
 */
function referencedNames(template: string): Set<string> {
  const names = new Set<string>();
  for (const expression of template.matchAll(EXPRESSION_PATTERN)) {
    const body = expression[1] ?? expression[2];
    for (const identifier of body.matchAll(IDENTIFIER_PATTERN)) {
      names.add(identifier[0]);
    }
  }
  return names;
}

/**
 * Reports whether a template parses and mentions every required placeholder.
 *
 * @param template The template to check.
 * @param requiredParams The placeholders the template must reference.
 * @returns Whether the template is usable. Never throws.
 */
export function isValidUserSimulatorTemplate(
  template: string,
  requiredParams: string[],
): boolean {
  try {
    new nunjucks.Template(
      template,
      createTemplateEnvironment(),
      undefined,
      true,
    );
  } catch {
    return false;
  }
  const referenced = referencedNames(template);
  return requiredParams.every((param) => referenced.has(param));
}

/** The inputs that select which instruction template a prompt renders. */
export interface UserSimulatorInstructionsTemplateOptions {
  /** Instructions that replace the built-in ones. */
  customInstructions?: string;

  /** The persona the simulated user adopts. */
  userPersona?: UserPersona;
}

/**
 * Picks the instruction template a simulated user follows.
 *
 * @param options The custom instructions and persona, if any.
 * @returns The template to render.
 * @throws {InputValidationError} If custom instructions are combined with a
 *     persona but do not reference every required placeholder.
 */
export function getUserSimulatorInstructionsTemplate(
  options: UserSimulatorInstructionsTemplateOptions = {},
): string {
  const {customInstructions, userPersona} = options;
  if (customInstructions === undefined) {
    return userPersona === undefined
      ? DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE
      : USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE;
  }
  if (userPersona === undefined) {
    return customInstructions;
  }
  if (
    !isValidUserSimulatorTemplate(
      customInstructions,
      REQUIRED_TEMPLATE_PARAMS_WITH_PERSONA,
    )
  ) {
    throw new InputValidationError(PERSONA_CUSTOM_INSTRUCTIONS_ERROR);
  }
  return customInstructions;
}

/**
 * Renders a persona with the extra field the instruction templates read.
 *
 * @param persona The persona to render.
 * @returns The persona, each behavior carrying its instructions as one bullet
 *     per line.
 */
function toRenderablePersona(persona: UserPersona) {
  return {
    ...persona,
    behaviors: persona.behaviors.map((behavior) => ({
      ...behavior,
      behaviorInstructionsText: behavior.behaviorInstructions
        .map((instruction) => `  * ${instruction}`)
        .join('\n'),
    })),
  };
}

/** Options for {@link getLlmBackedUserSimulatorPrompt}. */
export interface LlmBackedUserSimulatorPromptOptions extends UserSimulatorInstructionsTemplateOptions {
  /** The plan the simulated user follows. */
  conversationPlan: string;

  /** The conversation so far, as the simulated user sees it. */
  conversationHistory: string;

  /** The text the simulated user emits to end the conversation. */
  stopSignal: string;
}

/**
 * Builds the prompt that asks a model for the next user message.
 *
 * @param options The conversation state, and the custom instructions and
 *     persona to render with it.
 * @returns The rendered prompt.
 * @throws {InputValidationError} If custom instructions are combined with a
 *     persona but do not reference every required placeholder.
 */
export function getLlmBackedUserSimulatorPrompt(
  options: LlmBackedUserSimulatorPromptOptions,
): string {
  const template = getUserSimulatorInstructionsTemplate(options);
  const context: Record<string, unknown> = {
    stop_signal: options.stopSignal,
    conversation_plan: options.conversationPlan,
    conversation_history: options.conversationHistory,
  };
  if (options.userPersona !== undefined) {
    context['persona'] = toRenderablePersona(options.userPersona);
  }
  return createTemplateEnvironment().renderString(template, context);
}
