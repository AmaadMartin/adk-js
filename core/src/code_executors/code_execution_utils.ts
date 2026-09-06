/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Content, Language, Outcome, Part} from '@google/genai';
import {cloneDeep} from 'lodash-es';

import {base64Encode, isBase64Encoded} from '../utils/env_aware_utils.js';

export enum FileContentEncoding {
  UTF8 = 'utf-8',
  BASE64 = 'base64',
}

/**
 * A structure that contains a file name and its content
 */
export interface File {
  /**
   * The name of the file with file extension(e.g., ' file.csv')
   * */
  name: string;

  /**
   * The encoded bytes of the file content.
   * */
  content: string;

  /**
   * The encoding of the file content.
   */
  contentEncoding?: FileContentEncoding;

  /**
   * The mime type of the file (e.g., ' image / png')
   * */
  mimeType: string;
}

/**
 * The language of the code to execute.
 */
export enum CodeExecutionLanguage {
  UNSPECIFIED = 'unspecified',
  PYTHON = 'python',
  JAVASCRIPT = 'javascript',
  TYPESCRIPT = 'typescript',
  // Linux, WSL, macOS
  SHELL = 'shell',
  // Windows only
  POWERSHELL = 'powershell',
  WINDOWS_CMD = 'cmd',
}

/**
 * The languages the default code block fences declare. Keyed by the fence tag,
 * i.e. the leading delimiter with its backticks and whitespace stripped.
 */
const CODE_FENCE_LANGUAGES: Record<string, CodeExecutionLanguage> = {
  tool_code: CodeExecutionLanguage.PYTHON,
  python: CodeExecutionLanguage.PYTHON,
  javascript: CodeExecutionLanguage.JAVASCRIPT,
  typescript: CodeExecutionLanguage.TYPESCRIPT,
  bash: CodeExecutionLanguage.SHELL,
  sh: CodeExecutionLanguage.SHELL,
};

/**
 * Resolves the language a code fence declares.
 *
 * An executor may define custom delimiters such as `['<code>', '</code>']`,
 * and those blocks ran as Python before the fence tag was honoured, so an
 * unrecognised tag keeps falling back to Python.
 *
 * @param leadingDelimiter The matched opening delimiter of the code block.
 * @return The language the fence declares.
 */
function fenceLanguage(leadingDelimiter: string): CodeExecutionLanguage {
  const tag = leadingDelimiter.trim().replace(/^`+/, '').trim().toLowerCase();
  return CODE_FENCE_LANGUAGES[tag] ?? CodeExecutionLanguage.PYTHON;
}

/**
 * A code block extracted from model content, with the language its fence
 * declared.
 */
export interface ExtractedCode {
  /**
   * The code inside the block, without its delimiters.
   * */
  code: string;

  /**
   * The language the block's opening delimiter declared.
   * */
  language: CodeExecutionLanguage;
}

/**
 * A structure that contains the input of code execution.
 * */
export interface CodeExecutionInput {
  /**
   * The code to execute.
   * */
  code: string;

  /**
   * The language of the code to execute.
   */
  language: CodeExecutionLanguage;

  /**
   * The input files available to the code.
   * */
  inputFiles: File[];

  /**
   * The execution ID for the stateful code execution.
   * */
  executionId?: string;

  /**
   * Optional arguments to pass to the executed code/script.
   */
  args?: string[] | Record<string, string | number | boolean>;
}

/**
 * A structure that contains the result of code execution.
 * */
export interface CodeExecutionResult {
  /**
   * The standard output of the code execution.
   * */
  stdout: string;

  /**
   * The standard error of the code execution.
   * */
  stderr: string;

  /**
   * The output files from the code execution.
   * */
  outputFiles: File[];
}

/**
 * Gets the file content as a base64-encoded bytes.
 *
 * @param data The file content bytes.
 * @return The file content as a base64-encoded bytes.
 */
export function getEncodedFileContent(data: string): string {
  return isBase64Encoded(data) ? data : base64Encode(data);
}

/**
 * Extracts the first code block from the content and truncate everything after
 * it.
 *
 * @param content The mutable content to extract the code from.
 * @param codeBlockDelimiters The list of the enclosing delimiters to identify
 *     the code blocks.
 * @return The first code block and the language its fence declared, or
 *     undefined when the content holds no code block.
 */
export function extractCodeAndTruncateContent(
  content: Content,
  codeBlockDelimiters: Array<[string, string]>,
): ExtractedCode | undefined {
  if (!content.parts?.length) {
    return undefined;
  }

  // Extract the code from the executable code parts if there're no associated
  // code execution result parts.
  for (let i = 0; i < content.parts.length; i++) {
    const part = content.parts[i];
    if (
      part.executableCode &&
      (i === content.parts.length - 1 ||
        !content.parts[i + 1].codeExecutionResult)
    ) {
      content.parts = content.parts.slice(0, i + 1);
      const code = part.executableCode.code;
      // `Language` in `@google/genai` has no member besides `PYTHON`, so an
      // executable code part carries no other language to honour.
      return code ? {code, language: CodeExecutionLanguage.PYTHON} : undefined;
    }
  }

  // Extract the code from the text parts.
  const textParts = content.parts.filter((part) => part.text);
  if (!textParts.length) {
    return undefined;
  }

  const firstTextPart = cloneDeep(textParts[0])!;
  const responseText = textParts.map((part) => part.text!).join('\n');

  // Find the first code block.
  const leadingDelimiterPattern = codeBlockDelimiters
    .map((d) => d[0])
    .join('|');
  const trailingDelimiterPattern = codeBlockDelimiters
    .map((d) => d[1])
    .join('|');
  const match = new RegExp(
    `(?<prefix>.*?)(?<leading>${leadingDelimiterPattern})(?<codeStr>.*?)(${trailingDelimiterPattern})(?<suffix>.*?)$`,
    's',
  ).exec(responseText);

  // `leading` is a mandatory element of the pattern, so a match always defines
  // it, but `RegExpExecArray` only types groups as an index signature.
  const groups = match?.groups as
    | {prefix?: string; leading: string; codeStr?: string}
    | undefined;

  if (!groups?.codeStr) {
    return undefined;
  }

  const {prefix, leading, codeStr} = groups;

  content.parts = [];

  if (prefix) {
    firstTextPart.text = prefix;
    content.parts.push(firstTextPart);
  }
  content.parts.push(buildExecutableCodePart(codeStr));

  return {code: codeStr, language: fenceLanguage(leading)};
}

/**
 * Builds an executable code part with code string.
 *
 * @param code The code string.
 * @return The constructed executable code part.
 */
export function buildExecutableCodePart(code: string): Part {
  return {
    text: code,
    executableCode: {
      code,
      language: Language.PYTHON,
    },
  };
}

/**
 * Builds the code execution result part from the code execution result.
 *
 * @param codeExecutionResult The code execution result.
 * @return The code execution result part.
 */
export function buildCodeExecutionResultPart(
  codeExecutionResult: CodeExecutionResult,
): Part {
  if (codeExecutionResult.stderr) {
    return {
      text: codeExecutionResult.stderr,
      codeExecutionResult: {
        outcome: Outcome.OUTCOME_FAILED,
      },
    };
  }

  const finalResult = [];
  if (codeExecutionResult.stdout || !codeExecutionResult.outputFiles) {
    finalResult.push(`Code execution result:\n${codeExecutionResult.stdout}\n`);
  }
  if (codeExecutionResult.outputFiles) {
    finalResult.push(
      `Saved artifacts:\n` +
        codeExecutionResult.outputFiles.map((f) => f.name).join(', '),
    );
  }

  return {
    text: finalResult.join('\n\n'),
    codeExecutionResult: {
      outcome: Outcome.OUTCOME_OK,
    },
  };
}

/**
 * Converts the code execution parts to text parts in a Content.
 *
 * @param content The mutable content to convert the code execution parts to
 *     text parts.
 * @param codeBlockDelimiter The delimiter to format the code block.
 * @param executionResultDelimiters The delimiter to format the code execution
 *     result.
 * @return The converted content.
 */
export function convertCodeExecutionParts(
  content: Content,
  codeBlockDelimiter: [string, string],
  executionResultDelimiters: [string, string],
) {
  if (!content.parts?.length) {
    return;
  }

  const lastPart = content.parts[content.parts.length - 1];

  if (lastPart.executableCode) {
    content.parts[content.parts.length - 1] = {
      text:
        codeBlockDelimiter[0] +
        lastPart.executableCode.code +
        codeBlockDelimiter[1],
    };
  } else if (content.parts.length == 1 && lastPart.codeExecutionResult) {
    content.parts[content.parts.length - 1] = {
      text:
        executionResultDelimiters[0] +
        lastPart.codeExecutionResult.output +
        executionResultDelimiters[1],
    };
    content.role = 'user';
  }
}
