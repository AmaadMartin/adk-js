/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import nunjucks from 'nunjucks';

import {
  getBehaviorInstructionsStr,
  UserPersona,
} from './user_simulator_personas.js';

/**
 * Default instruction template used when no persona is supplied.
 *
 * Ported verbatim from the adk-python
 * `_DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE`.
 */
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
 * Instruction template used when a persona is supplied.
 *
 * Ported verbatim from the adk-python
 * `_USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE`.
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
{{ b.get_behavior_instructions_str() | render_string_filter }}
{% endfor %}
# Conversation Plan

{{ conversation_plan }}

# Conversation History

{{ conversation_history }}`;

/** The selectable instruction templates (overridable, e.g. for testing). */
export interface UserSimulatorTemplates {
  /** Template used when no persona is supplied. */
  default: string;
  /** Template used when a persona is supplied. */
  withPersona: string;
}

const DEFAULT_TEMPLATES: UserSimulatorTemplates = {
  default: DEFAULT_USER_SIMULATOR_INSTRUCTIONS_TEMPLATE,
  withPersona: USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Checks whether `templateStr` is a syntactically valid template that
 * references every one of `requiredParams`.
 *
 * The required params are fixed top-level placeholders (e.g. `stop_signal`), so
 * validity is checked with nunjucks' public `Template` compiler (syntax) plus a
 * scan of the identifiers appearing inside `{{ ... }}` / `{% ... %}` blocks --
 * avoiding a dependency on nunjucks' private parser AST.
 *
 * @param templateStr The template to inspect.
 * @param requiredParams The variable names that must appear.
 * @returns `true` if valid and all required params are present.
 */
export function isValidUserSimulatorTemplate(
  templateStr: string,
  requiredParams: string[],
): boolean {
  try {
    // Eager compilation throws on a syntax error.
    new nunjucks.Template(templateStr, undefined, undefined, true);
  } catch {
    return false;
  }
  const expressions =
    templateStr.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? [];
  const referenced = new Set(
    expressions.join(' ').match(/[A-Za-z_$][\w$]*/g) ?? [],
  );
  return requiredParams.every((param) => referenced.has(param));
}

/**
 * Returns the instruction template to use for the user simulator.
 *
 * Selection: no custom + no persona -> default; custom only -> custom; persona
 * only -> persona template; custom + persona -> the custom template, but only
 * if it is valid with the persona placeholder (else throws).
 *
 * @param customInstructions Optional custom instruction template.
 * @param userPersona Optional persona.
 * @param templates Overridable template set (defaults to the built-in ones).
 * @returns The selected template string.
 * @throws {Error} If custom instructions are supplied with a persona but do not
 *     contain all required placeholders.
 */
export function getUserSimulatorInstructionsTemplate(
  customInstructions?: string,
  userPersona?: UserPersona,
  templates: UserSimulatorTemplates = DEFAULT_TEMPLATES,
): string {
  if (customInstructions === undefined) {
    return userPersona === undefined
      ? templates.default
      : templates.withPersona;
  }
  if (userPersona === undefined) {
    return customInstructions;
  }
  if (
    !isValidUserSimulatorTemplate(customInstructions, [
      'stop_signal',
      'conversation_plan',
      'conversation_history',
      'persona',
    ])
  ) {
    throw new Error(
      'Custom instructions using personas must contain the following' +
        ' formatting placeholders following Jinja syntax: {{ stop_signal }},' +
        ' {{ conversation_plan }}, {{ conversation_history }}, {{ persona }}',
    );
  }
  return customInstructions;
}

/**
 * Re-renders a persona sub-field string against `vars` using a restricted,
 * variable-only interpolation.
 *
 * Divergence from adk-python: rather than Jinja's `SandboxedEnvironment` (which
 * raises `SecurityError` on Python-internal attribute access), only simple
 * dotted own-property paths are substituted. This contains template injection
 * by construction -- nunjucks is NOT sandboxed against
 * `constructor.constructor(...)` SSTI, so persona-authored fields are never
 * evaluated as full nunjucks templates. Any non-trivial expression (function
 * calls, prototype access) renders inert (empty) rather than executing.
 */
function safeInterpolate(
  templateStr: string,
  vars: Record<string, unknown>,
): string {
  return templateStr.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_match, expr) => {
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(expr)) {
      return '';
    }
    let current: unknown = vars;
    for (const segment of (expr as string).split('.')) {
      if (
        !isObject(current) ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return '';
      }
      current = current[segment];
    }
    return String(current);
  });
}

/**
 * Wraps a persona so its behaviors expose a `get_behavior_instructions_str`
 * method callable from the template, matching the adk-python template.
 */
function toTemplatePersona(persona: UserPersona): Record<string, unknown> {
  return {
    ...persona,
    behaviors: persona.behaviors.map((behavior) => ({
      ...behavior,
      get_behavior_instructions_str: () => getBehaviorInstructionsStr(behavior),
    })),
  };
}

/**
 * The nunjucks render context bound as `this` inside a filter.
 *
 * `@types/nunjucks` (3.2.6) does not export the runtime `Context` class, so the
 * single member the filter needs is declared locally rather than cast away.
 */
interface FilterContext {
  getVariables(): Record<string, unknown>;
}

/**
 * Re-renders a persona sub-field against the *enclosing render's* variables.
 *
 * Reads its context from `this` at render time rather than from the
 * environment, so it holds no per-render state and is safe to register once on
 * a shared environment.
 */
function renderStringFilter(this: FilterContext, str: string): string {
  if (!str) return '';
  return safeInterpolate(str, this.getVariables());
}

/**
 * The shared nunjucks environment used to render simulator prompts.
 *
 * Static configuration -- neither the options nor the filter depend on the
 * per-call arguments -- so it is built once at module load instead of once per
 * simulated turn.
 */
const SIMULATOR_ENV = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});
SIMULATOR_ENV.addFilter('render_string_filter', renderStringFilter);

/**
 * Formats the prompt for the LLM-backed user simulator.
 *
 * @param params.conversationPlan The conversation plan.
 * @param params.conversationHistory The summarized conversation so far.
 * @param params.stopSignal The stop-signal marker.
 * @param params.customInstructions Optional custom instruction template.
 * @param params.userPersona Optional persona to role-play.
 * @param params.templates Overridable template set (defaults to built-in).
 * @returns The rendered prompt.
 */
export function getLlmBackedUserSimulatorPrompt(params: {
  conversationPlan: string;
  conversationHistory: string;
  stopSignal: string;
  customInstructions?: string;
  userPersona?: UserPersona;
  templates?: UserSimulatorTemplates;
}): string {
  const {
    conversationPlan,
    conversationHistory,
    stopSignal,
    customInstructions,
    userPersona,
    templates = DEFAULT_TEMPLATES,
  } = params;

  const templateStr = getUserSimulatorInstructionsTemplate(
    customInstructions,
    userPersona,
    templates,
  );

  const templateParameters: Record<string, unknown> = {
    stop_signal: stopSignal,
    conversation_plan: conversationPlan,
    conversation_history: conversationHistory,
  };
  if (userPersona !== undefined) {
    templateParameters.persona = toTemplatePersona(userPersona);
  }

  return SIMULATOR_ENV.renderString(templateStr, templateParameters);
}
