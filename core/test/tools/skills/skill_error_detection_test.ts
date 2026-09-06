/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  detectSkillToolError,
  ListSkillsTool,
  LoadSkillResourceTool,
  LoadSkillTool,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SKILL: Skill = {
  frontmatter: {name: 'skill1', description: 'A test skill'},
  instructions: 'Test instructions',
};

function tools() {
  const toolset = new SkillToolset([SKILL]);
  return {
    loadSkill: new LoadSkillTool(toolset),
    loadResource: new LoadSkillResourceTool(toolset),
    runScript: new RunSkillScriptTool(toolset),
    listSkills: new ListSkillsTool(toolset),
  };
}

describe('detectSkillToolError', () => {
  it('returns the snake_case error code', () => {
    expect(
      detectSkillToolError({error: 'boom', error_code: 'SKILL_NOT_FOUND'}),
    ).toBe('SKILL_NOT_FOUND');
  });

  it('returns the camelCase error code', () => {
    expect(
      detectSkillToolError({error: 'boom', errorCode: 'SCRIPT_NOT_FOUND'}),
    ).toBe('SCRIPT_NOT_FOUND');
  });

  it('falls back to TOOL_ERROR when the code is missing', () => {
    expect(detectSkillToolError({error: 'boom'})).toBe('TOOL_ERROR');
  });

  it('falls back to TOOL_ERROR when the code is not a string', () => {
    expect(detectSkillToolError({error: 'boom', error_code: 7})).toBe(
      'TOOL_ERROR',
    );
  });

  it('returns undefined for a successful response', () => {
    expect(detectSkillToolError({content: 'body'})).toBeUndefined();
  });

  it('returns undefined for a non-record response', () => {
    expect(detectSkillToolError('<available_skills/>')).toBeUndefined();
    expect(detectSkillToolError(null)).toBeUndefined();
  });
});

describe('detectErrorInResponse on the skill tools', () => {
  it('reports the code each tool put in its response', () => {
    const {loadSkill, loadResource, runScript} = tools();

    expect(
      loadSkill.detectErrorInResponse({
        error: 'boom',
        error_code: 'REGISTRY_ERROR',
      }),
    ).toBe('REGISTRY_ERROR');
    expect(
      loadResource.detectErrorInResponse({
        error: 'boom',
        error_code: 'RESOURCE_NOT_FOUND_FATAL',
      }),
    ).toBe('RESOURCE_NOT_FOUND_FATAL');
    expect(
      runScript.detectErrorInResponse({
        error: 'boom',
        errorCode: 'EXECUTION_ERROR',
      }),
    ).toBe('EXECUTION_ERROR');
  });

  it('falls back to TOOL_ERROR on each tool', () => {
    const {loadSkill, loadResource, runScript} = tools();

    for (const tool of [loadSkill, loadResource, runScript]) {
      expect(tool.detectErrorInResponse({error: 'boom'})).toBe('TOOL_ERROR');
    }
  });

  it('reports a failed script run that carries no error field', () => {
    const {runScript} = tools();

    expect(
      runScript.detectErrorInResponse({
        stdout: '',
        stderr: 'boom',
        status: 'error',
      }),
    ).toBe('SKILL_SCRIPT_EXECUTION_ERROR');
  });

  it('does not report a warning or a success from run_skill_script', () => {
    const {runScript} = tools();

    expect(
      runScript.detectErrorInResponse({status: 'warning'}),
    ).toBeUndefined();
    expect(
      runScript.detectErrorInResponse({status: 'success'}),
    ).toBeUndefined();
    expect(runScript.detectErrorInResponse('plain string')).toBeUndefined();
  });

  it('leaves list_skills without a hook, as adk-python does', () => {
    const {listSkills} = tools();

    // `BaseTool` declares the hook optional, so a tool that classifies nothing
    // carries no `detectErrorInResponse` at all.
    expect(listSkills.detectErrorInResponse).toBeUndefined();
  });

  it('does not mutate the response it inspects', () => {
    const {runScript} = tools();
    const response = {error: 'boom', errorCode: 'EXECUTION_ERROR'};

    runScript.detectErrorInResponse(response);

    expect(response).toEqual({error: 'boom', errorCode: 'EXECUTION_ERROR'});
  });
});
