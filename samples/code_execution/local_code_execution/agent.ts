/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local code execution
 * ../../../docs/guides/code_executors/index.md
 *
 * An agent that answers questions by writing Python and running it. The model
 * writes a fenced code block, `UnsafeLocalCodeExecutor` runs it on this machine
 * with `python3`, and the model reads the printed output before it answers.
 * Any file the code writes into its working directory comes back as an
 * artifact.
 *
 * The agent is given a code executor, not a tool. The executor watches every
 * model response for the first fenced code block, runs it, and sends the
 * output back as the next turn. The model never calls a function, so nothing
 * appears in the tool list.
 *
 * Every block the flow executes is run as Python, whatever its fence says, so
 * the instruction asks for Python only.
 *
 * WARNING: `UnsafeLocalCodeExecutor` has no sandbox. The model's code runs as
 * the current user with full access to the file system and the network. Run
 * this sample only on a machine where that is acceptable, and use
 * `ContainerCodeExecutor` for anything else.
 *
 * REQUIRES an API key (the agent calls a live model) and `python3` on the
 * PATH. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/code_execution/local_code_execution/agent.ts
 * Try "what is the 50th Fibonacci number?".
 */

import {LlmAgent, UnsafeLocalCodeExecutor} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'local_code_execution',
  model: 'gemini-flash-latest',
  description: 'Answers questions by writing and running Python code.',
  instruction: `You answer questions that need calculation or data processing
by writing Python and running it.

When you need a result, reply with exactly one Python code block fenced as
\`\`\`python and nothing after it. Print every value you want to see. The output
comes back to you in a \`\`\`tool_output block. Never write a tool_output block
yourself.

Variables do not carry over between code blocks, so each block must define
everything it uses. Use only the Python standard library. To produce a file,
write it to the current working directory.

Once you have the output you need, answer in plain text and show the key
numbers.`,
  codeExecutor: new UnsafeLocalCodeExecutor({timeoutSeconds: 30}),
});
