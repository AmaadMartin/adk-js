/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * adk-python loops over the persona's behaviors inside the template. Every
 * placeholder here is a plain name, so {@link getLlmBackedUserSimulatorPrompt}
 * renders the behavior list into `persona.behaviors` instead. The text the
 * model receives is the same.
 */
export const USER_SIMULATOR_INSTRUCTIONS_WITH_PERSONA_TEMPLATE = `You are a Simulated User designed to test an AI Agent.

Your single most important job is to react logically to the Agent's last message while role-playing as the given Persona.
The Conversation Plan is your canonical grounding, not a script; your response MUST be dictated by what the Agent just said.

# Persona Description

{{ persona.description }}
This persona behaves in the following ways:
{{ persona.behaviors }}
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

/**
 * Matches one `{{ name }}` or `{{ name.field }}` placeholder.
 *
 * A placeholder holds a dotted name and nothing else. An expression, a filter
 * or a call does not match it, and {@link isValidUserSimulatorTemplate}
 * rejects a template that contains one.
 */
const PLACEHOLDER_PATTERN =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

/**
 * Substitutes a template's placeholders.
 *
 * A placeholder the context does not name renders as the empty string, which
 * is what Jinja2 does with an undefined variable. Each name is looked up whole
 * in a `Map`, so a template cannot walk an object and reach a function through
 * it.
 *
 * This is deliberately not a template engine. Persona text and custom
 * instructions are evaluation data, and nunjucks — the closest JavaScript has
 * to Jinja2 — documents templates as trusted code and offers no counterpart to
 * Jinja2's `SandboxedEnvironment`. Rendering that data through it makes
 * `{{ range.constructor('...')() }}` execute.
 *
 * @param template The template to render.
 * @param context The value of each placeholder.
 * @returns The rendered text.
 */
function renderTemplate(
  template: string,
  context: ReadonlyMap<string, string>,
): string {
  // A replacement function, so a value containing `$&` is inserted literally.
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_placeholder, name: string) => context.get(name) ?? '',
  );
}

/**
 * Reports whether a template uses syntax the renderer does not support.
 *
 * A leftover `{{` is an unclosed placeholder or an expression, and `{%` opens
 * a Jinja statement. A template holding either is rejected, rather than
 * reaching the model as literal text.
 *
 * @param template The template to check.
 * @returns Whether the template holds unsupported syntax.
 */
function hasUnsupportedSyntax(template: string): boolean {
  return (
    template.replace(PLACEHOLDER_PATTERN, '').includes('{{') ||
    template.includes('{%')
  );
}

/**
 * Collects the first segment of every placeholder in a template.
 *
 * @param template The template to scan.
 * @returns The name each placeholder starts with.
 */
function placeholderRoots(template: string): Set<string> {
  const roots = new Set<string>();
  for (const placeholder of template.matchAll(PLACEHOLDER_PATTERN)) {
    roots.add(placeholder[1].split('.')[0]);
  }
  return roots;
}

/**
 * Reports whether a template is supported and references every required
 * placeholder.
 *
 * @param template The template to check.
 * @param requiredParams The placeholders the template must reference.
 * @returns Whether the template is usable. Never throws.
 */
export function isValidUserSimulatorTemplate(
  template: string,
  requiredParams: string[],
): boolean {
  if (hasUnsupportedSyntax(template)) {
    return false;
  }
  const roots = placeholderRoots(template);
  return requiredParams.every((param) => roots.has(param));
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
 * Renders a persona's behaviors as the block the instructions embed.
 *
 * A behavior's own text is rendered as well, so a persona may refer to the
 * stop signal or the conversation plan, which is what adk-python's
 * `render_string_filter` allows.
 *
 * @param persona The persona to render.
 * @param context The value of each placeholder.
 * @returns One block per behavior, each opening with a blank line.
 */
function renderBehaviors(
  persona: UserPersona,
  context: ReadonlyMap<string, string>,
): string {
  return persona.behaviors
    .map((behavior) => {
      const instructions = behavior.behaviorInstructions
        .map((instruction) => `  * ${renderTemplate(instruction, context)}`)
        .join('\n');
      return (
        `\n## ${renderTemplate(behavior.name, context)}\n` +
        `${renderTemplate(behavior.description, context)}\n\n` +
        `Instructions:\n${instructions}\n`
      );
    })
    .join('');
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
 * A persona contributes `{{ persona.id }}`, `{{ persona.description }}` and
 * `{{ persona.behaviors }}`. Bare `{{ persona }}` renders the description
 * followed by the behaviors.
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
  const context = new Map<string, string>([
    ['stop_signal', options.stopSignal],
    ['conversation_plan', options.conversationPlan],
    ['conversation_history', options.conversationHistory],
  ]);

  const persona = options.userPersona;
  if (persona !== undefined) {
    // The description is inserted verbatim, as adk-python does: its
    // `render_string_filter` reaches each behavior, not the description.
    const behaviors = renderBehaviors(persona, context);
    context.set('persona.id', persona.id);
    context.set('persona.description', persona.description);
    context.set('persona.behaviors', behaviors);
    context.set('persona', `${persona.description}\n${behaviors}`);
  }

  return renderTemplate(template, context);
}
