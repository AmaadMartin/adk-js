/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import nunjucks from 'nunjucks';

import {InputValidationError} from '../../errors/input_validation_error.js';

import type {UserPersona} from './user_simulator_personas.js';

/** The instructions used when the scenario names no persona. */
const DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE = `You are a Simulated User designed to test an AI Agent.

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

/** The instructions used when the scenario names a persona. */
const USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE = `You are a Simulated User designed to test an AI Agent.

Your single most important job is to react logically to the Agent's last message while role-playing as the given Persona.
The Conversation Plan is your canonical grounding, not a script; your response MUST be dictated by what the Agent just said.

# Persona Description

{{ persona.description }}
This persona behaves in the following ways:
{% for b in persona.behaviors %}
## {{ b.name | render_string_filter}}
{{ b.description | render_string_filter }}

Instructions:
{{ b.behavior_instructions_str | render_string_filter }}
{% endfor %}
# Conversation Plan

{{ conversation_plan }}

# Conversation History

{{ conversation_history }}`;

/** The placeholders every set of custom instructions must name. */
export const REQUIRED_TEMPLATE_PARAMS = [
  'stop_signal',
  'conversation_plan',
  'conversation_history',
];

/** The placeholder custom instructions must add when a persona is in play. */
const PERSONA_TEMPLATE_PARAM = 'persona';

const PERSONA_INSTRUCTIONS_ERROR =
  'Custom instructions using personas must contain the following formatting' +
  ' placeholders following Jinja syntax: {{ stop_signal }},' +
  ' {{ conversation_plan }}, {{ conversation_history }}, {{ persona }}';

/** Matches a `{{ ... }}` or `{% ... %}` block. */
const TEMPLATE_EXPRESSION = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;

/** Matches a member access, so `persona.description` reads as `persona`. */
const MEMBER_ACCESS = /\.\s*[A-Za-z_$][\w$]*/g;

/** Matches an identifier. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Matches a dotted path of identifiers, and nothing more complex. */
const DOTTED_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** Matches a `{{ ... }}` block, capturing what is inside it. */
const INTERPOLATION = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Returns the variables a template reads, ignoring member accesses.
 *
 * A member access is dropped so that `{{ persona.description }}` reads as a
 * reference to `persona` alone. Names the template itself binds, such as the
 * target of a `{% for %}`, are not filtered out; no required placeholder is
 * ever spelled like one.
 */
function referencedVariables(templateStr: string): Set<string> {
  const expressions = templateStr.match(TEMPLATE_EXPRESSION) ?? [];
  const withoutMembers = expressions.join(' ').replace(MEMBER_ACCESS, ' ');
  return new Set(withoutMembers.match(IDENTIFIER) ?? []);
}

/**
 * Reports whether a template parses and reads every required placeholder.
 *
 * @param templateStr The template to check.
 * @param requiredParams The placeholders the template must read.
 * @returns `false` when the template does not parse, or when it omits a
 *   required placeholder.
 */
export function isValidUserSimulatorTemplate(
  templateStr: string,
  requiredParams: string[],
): boolean {
  try {
    // Eager compilation is what reports a syntax error.
    new nunjucks.Template(templateStr, undefined, undefined, true);
  } catch {
    return false;
  }
  const referenced = referencedVariables(templateStr);
  return requiredParams.every((param) => referenced.has(param));
}

/**
 * Returns the instruction template the simulator renders.
 *
 * Custom instructions replace the built-in template. Combined with a persona
 * they must also read `{{ persona }}`, because nothing else would put the
 * persona in front of the model.
 *
 * @param customInstructions The instructions that replace the built-in ones.
 * @param userPersona The persona the simulated user adopts.
 * @returns The template to render.
 * @throws {InputValidationError} When custom instructions accompany a persona
 *   but omit a required placeholder.
 */
export function getUserSimulatorInstructionsTemplate(
  customInstructions?: string,
  userPersona?: UserPersona,
): string {
  if (customInstructions === undefined) {
    return userPersona === undefined
      ? DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE
      : USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE;
  }
  if (userPersona === undefined) {
    return customInstructions;
  }
  if (
    !isValidUserSimulatorTemplate(customInstructions, [
      ...REQUIRED_TEMPLATE_PARAMS,
      PERSONA_TEMPLATE_PARAM,
    ])
  ) {
    throw new InputValidationError(PERSONA_INSTRUCTIONS_ERROR);
  }
  return customInstructions;
}

/** Reports whether a value can carry properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Substitutes `{{ dotted.path }}` references in a persona field.
 *
 * Only a plain dotted path over an own property is substituted. Anything else,
 * a call or a prototype walk included, renders empty. adk-python compiles the
 * field with Jinja's `SandboxedEnvironment` instead; nunjucks offers no
 * sandbox, and `constructor.constructor` reaches the `Function` constructor
 * from any object, so a persona field that may come from a data file is never
 * compiled here.
 */
function interpolateVariables(
  templateStr: string,
  variables: Record<string, unknown>,
): string {
  return templateStr.replace(INTERPOLATION, (_match, expression: string) => {
    if (!DOTTED_PATH.test(expression)) {
      return '';
    }
    let current: unknown = variables;
    for (const segment of expression.split('.')) {
      if (
        !isRecord(current) ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return '';
      }
      current = current[segment];
    }
    return String(current);
  });
}

/** The single member of the nunjucks render context a filter reads. */
interface FilterContext {
  getVariables(): Record<string, unknown>;
}

/**
 * Substitutes a persona field against the variables of the enclosing render.
 *
 * nunjucks binds `this` to the render context, so the filter holds no state of
 * its own and one registration serves every render.
 */
function renderStringFilter(this: FilterContext, value: string): string {
  return value ? interpolateVariables(value, this.getVariables()) : '';
}

/** Renders the simulator prompts. Static, so one environment serves them all. */
const SIMULATOR_ENV = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});
SIMULATOR_ENV.addFilter('render_string_filter', renderStringFilter);

/**
 * Gives each behavior the `behavior_instructions_str` the persona template
 * reads. adk-python's template calls a method here; the value is precomputed
 * so that no callable enters the render context.
 */
function toTemplatePersona(persona: UserPersona): Record<string, unknown> {
  return {
    ...persona,
    behaviors: persona.behaviors.map((behavior) => ({
      ...behavior,
      behavior_instructions_str: behavior.behaviorInstructions
        .map((instruction) => `  * ${instruction}`)
        .join('\n'),
    })),
  };
}

/**
 * Renders the prompt that asks a model for the next user message.
 *
 * The conversation plan and the conversation history are bound as variables,
 * never compiled, because the agent under test writes part of the history.
 *
 * @param params.conversationPlan The plan the simulated user follows.
 * @param params.conversationHistory The conversation so far, summarized.
 * @param params.stopSignal The text the model writes to end the conversation.
 * @param params.customInstructions Instructions replacing the built-in ones.
 * @param params.userPersona The persona the simulated user adopts.
 * @returns The rendered prompt.
 * @throws {InputValidationError} When custom instructions accompany a persona
 *   but omit a required placeholder.
 */
export function getLlmBackedUserSimulatorPrompt(params: {
  conversationPlan: string;
  conversationHistory: string;
  stopSignal: string;
  customInstructions?: string;
  userPersona?: UserPersona;
}): string {
  const templateStr = getUserSimulatorInstructionsTemplate(
    params.customInstructions,
    params.userPersona,
  );
  const templateParameters: Record<string, unknown> = {
    stop_signal: params.stopSignal,
    conversation_plan: params.conversationPlan,
    conversation_history: params.conversationHistory,
  };
  if (params.userPersona !== undefined) {
    templateParameters['persona'] = toTemplatePersona(params.userPersona);
  }
  return SIMULATOR_ENV.renderString(templateStr, templateParameters);
}
