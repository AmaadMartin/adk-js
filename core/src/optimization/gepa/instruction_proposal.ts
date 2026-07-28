/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The inputs required to render an instruction-proposal prompt.
 */
export interface InstructionProposalInput {
  /** The current text of the component being optimized. */
  currentInstructionDoc: string;

  /** The reflection rows (score + eval data) gathered for the component. */
  datasetWithFeedback: Array<Record<string, unknown>>;

  /**
   * The meta-prompt template with `<curr_param>` and `<side_info>` markers to
   * substitute the current text and serialized feedback into, respectively.
   */
  promptTemplate: string;
}

/** Matches the last fenced (triple-backtick) block in an LM response. */
const FENCED_BLOCK_REGEX = /```[^\n]*\n([\s\S]*?)```/g;

/**
 * Renders an instruction-proposal prompt.
 *
 * Substitutes the current component text into the template's `<curr_param>`
 * marker and the serialized feedback dataset into its `<side_info>` marker.
 * This is the adk-js analogue of the `gepa` package's
 * `InstructionProposalSignature.prompt_renderer`.
 *
 * @param input The current text, feedback dataset, and meta-prompt template.
 * @return The rendered proposal prompt.
 */
export function renderInstructionProposal(
  input: InstructionProposalInput,
): string {
  const sideInfo = JSON.stringify(input.datasetWithFeedback);
  return input.promptTemplate
    .replace('<curr_param>', () => input.currentInstructionDoc)
    .replace('<side_info>', () => sideInfo);
}

/**
 * Extracts a proposed instruction from an LM response.
 *
 * Returns the contents of the final triple-backtick fenced block (the
 * convention the meta-prompt templates ask the model to follow). Falls back to
 * the trimmed whole response when no fenced block is present. This is the
 * adk-js analogue of the `gepa` package's
 * `InstructionProposalSignature.output_extractor`.
 *
 * @param lmOut The raw text returned by the reflection LM.
 * @return The extracted instruction text.
 */
export function extractProposedInstruction(lmOut: string): string {
  let lastBlock: string | undefined;
  for (const match of lmOut.matchAll(FENCED_BLOCK_REGEX)) {
    lastBlock = match[1];
  }
  return (lastBlock ?? lmOut).trim();
}
