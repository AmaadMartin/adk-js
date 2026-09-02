/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AlreadyExistsError,
  EvalCase,
  InputValidationError,
  loadEvalSetFromFile,
  LocalEvalSetsManager,
  NotFoundError,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  // Wrapping the real functions keeps every other test on the real file
  // system, while letting one test make a single call fail.
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    writeFile: vi.fn(actual.writeFile),
  };
});

const APP_NAME = 'home_automation';
const EVAL_SET_ID = 'smoke';

/** An eval set as adk-python writes it: snake_case keys. */
const ON_DISK_EVAL_SET = {
  eval_set_id: EVAL_SET_ID,
  name: EVAL_SET_ID,
  creation_timestamp: 12.5,
  eval_cases: [
    {
      eval_id: 'lights_on',
      creation_timestamp: 12.5,
      conversation: [
        {
          invocation_id: 'inv-1',
          user_content: {role: 'user', parts: [{text: 'Lights on'}]},
        },
      ],
    },
  ],
};

/** Eval data in ADK's original format, which records no eval set id. */
const LEGACY_EVAL_DATA = [
  {
    name: 'roll_a_die',
    data: [{query: 'Roll a die', reference: 'I rolled a 4.'}],
    initial_session: {app_name: APP_NAME, user_id: 'user', state: {}},
  },
];

let agentsDir: string;
let manager: LocalEvalSetsManager;

function evalCase(evalId: string, text: string): EvalCase {
  return {
    evalId,
    conversation: [{userContent: {role: 'user', parts: [{text}]}}],
    creationTimestamp: 1,
  };
}

async function writeAppFile(name: string, contents: unknown): Promise<string> {
  const filePath = path.join(agentsDir, APP_NAME, name);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, JSON.stringify(contents), 'utf-8');
  return filePath;
}

beforeEach(async () => {
  agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-eval-sets-'));
  manager = new LocalEvalSetsManager(agentsDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(agentsDir, {recursive: true, force: true});
});

describe('LocalEvalSetsManager', () => {
  it('creates the eval set file under the app directory', async () => {
    const created = await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    expect(created.evalSetId).toBe(EVAL_SET_ID);
    const written = await fs.readFile(
      path.join(agentsDir, APP_NAME, `${EVAL_SET_ID}.evalset.json`),
      'utf-8',
    );
    expect(JSON.parse(written)).toMatchObject({
      eval_set_id: EVAL_SET_ID,
      name: EVAL_SET_ID,
      eval_cases: [],
    });
  });

  it('refuses to create an eval set twice', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    await expect(
      manager.createEvalSet(APP_NAME, EVAL_SET_ID),
    ).rejects.toThrowError(
      new AlreadyExistsError(
        `EvalSet ${EVAL_SET_ID} already exists for app ${APP_NAME}.`,
      ),
    );
  });

  it('refuses an eval set id that is not alphanumeric', async () => {
    await expect(
      manager.createEvalSet(APP_NAME, 'not ok'),
    ).rejects.toThrowError(
      new InputValidationError(
        'Invalid Eval Set ID. Eval Set ID should have the ' +
          '`^[a-zA-Z0-9_]+$` format',
      ),
    );
  });

  it('reports no eval set when the file is absent', async () => {
    expect(await manager.getEvalSet(APP_NAME, EVAL_SET_ID)).toBeUndefined();
    expect(
      await manager.getEvalCase(APP_NAME, EVAL_SET_ID, 'lights_on'),
    ).toBeUndefined();
  });

  it('reads an eval set file written in the current schema', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, ON_DISK_EVAL_SET);

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);

    expect(evalSet?.evalCases.map((known) => known.evalId)).toEqual([
      'lights_on',
    ]);
    const evalCaseRead = await manager.getEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      'lights_on',
    );
    expect(evalCaseRead?.conversation?.[0].userContent.parts?.[0].text).toBe(
      'Lights on',
    );
  });

  it('falls back to the original format for an old eval set file', async () => {
    await writeAppFile(`${EVAL_SET_ID}.evalset.json`, LEGACY_EVAL_DATA);

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);

    expect(evalSet?.evalSetId).toBe(EVAL_SET_ID);
    expect(evalSet?.evalCases.map((known) => known.evalId)).toEqual([
      'roll_a_die',
    ]);
    expect(evalSet?.evalCases[0].sessionInput?.userId).toBe('user');
  });

  it('surfaces the parse error of a file that is not JSON', async () => {
    const filePath = path.join(
      agentsDir,
      APP_NAME,
      `${EVAL_SET_ID}.evalset.json`,
    );
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, 'not json at all', 'utf-8');

    await expect(manager.getEvalSet(APP_NAME, EVAL_SET_ID)).rejects.toThrow(
      SyntaxError,
    );
  });

  it('lists only eval set files, sorted', async () => {
    await manager.createEvalSet(APP_NAME, 'second');
    await manager.createEvalSet(APP_NAME, 'first');
    await writeAppFile('notes.json', {});

    expect(await manager.listEvalSets(APP_NAME)).toEqual(['first', 'second']);
  });

  it('reports an app that has no eval directory', async () => {
    await expect(manager.listEvalSets('unknown')).rejects.toThrowError(
      new NotFoundError('Eval directory for app `unknown` not found.'),
    );
  });

  it('surfaces a listing failure that is not a missing directory', async () => {
    const failure = Object.assign(new Error('disk on fire'), {code: 'EIO'});
    vi.mocked(fs.readdir).mockRejectedValueOnce(failure);

    await expect(manager.listEvalSets(APP_NAME)).rejects.toBe(failure);
  });

  it('surfaces a create failure that is not an existing file', async () => {
    const failure = Object.assign(new Error('disk on fire'), {code: 'EIO'});
    vi.mocked(fs.writeFile).mockRejectedValueOnce(failure);

    await expect(manager.createEvalSet(APP_NAME, EVAL_SET_ID)).rejects.toBe(
      failure,
    );
  });

  it('adds, updates and deletes an eval case through the file', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);

    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase('one', 'first'));
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase('two', 'second'));
    await manager.updateEvalCase(
      APP_NAME,
      EVAL_SET_ID,
      evalCase('one', 'updated'),
    );
    await manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, 'two');

    const evalSet = await manager.getEvalSet(APP_NAME, EVAL_SET_ID);
    expect(evalSet?.evalCases.map((known) => known.evalId)).toEqual(['one']);
    expect(
      evalSet?.evalCases[0].conversation?.[0].userContent.parts?.[0].text,
    ).toBe('updated');
  });

  it('refuses to add an eval case the set already holds', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    await manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase('one', 'first'));

    await expect(
      manager.addEvalCase(APP_NAME, EVAL_SET_ID, evalCase('one', 'again')),
    ).rejects.toThrowError(
      new AlreadyExistsError(
        `Eval id \`one\` already exists in \`${EVAL_SET_ID}\` eval set.`,
      ),
    );
  });

  it('reports an unknown eval case on update and on delete', async () => {
    await manager.createEvalSet(APP_NAME, EVAL_SET_ID);
    const missing = new NotFoundError(
      `Eval case \`ghost\` not found in eval set \`${EVAL_SET_ID}\`.`,
    );

    await expect(
      manager.updateEvalCase(APP_NAME, EVAL_SET_ID, evalCase('ghost', 'x')),
    ).rejects.toThrowError(missing);
    await expect(
      manager.deleteEvalCase(APP_NAME, EVAL_SET_ID, 'ghost'),
    ).rejects.toThrowError(missing);
  });

  it('reports an unknown eval set when editing a case', async () => {
    await expect(
      manager.addEvalCase(APP_NAME, 'ghost_set', evalCase('one', 'x')),
    ).rejects.toThrowError(
      new NotFoundError('Eval set `ghost_set` not found.'),
    );
  });

  it('refuses an app name or an eval set id that walks out of the directory', async () => {
    await expect(manager.getEvalSet('../escape', EVAL_SET_ID)).rejects.toThrow(
      InputValidationError,
    );
    await expect(manager.getEvalSet(APP_NAME, '../escape')).rejects.toThrow(
      InputValidationError,
    );
    await expect(manager.listEvalSets('../escape')).rejects.toThrow(
      InputValidationError,
    );
  });
});

describe('loadEvalSetFromFile', () => {
  it('names a set read from the original format after the caller', async () => {
    const filePath = await writeAppFile('legacy.json', LEGACY_EVAL_DATA);

    const evalSet = await loadEvalSetFromFile(filePath, 'chosen_id');

    expect(evalSet.evalSetId).toBe('chosen_id');
  });

  it('reads an old eval case that records no initial session', async () => {
    const filePath = await writeAppFile('legacy.json', [
      {name: 'no_session', data: [{query: 'Hi'}]},
    ]);

    const evalSet = await loadEvalSetFromFile(filePath, 'chosen_id');

    expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
  });

  it('reports a file that holds neither schema', async () => {
    const filePath = await writeAppFile('bad.json', [{noName: true}]);

    await expect(loadEvalSetFromFile(filePath, 'chosen_id')).rejects.toThrow(
      'Every eval case in the original format must have a `name` and `data`.',
    );
  });

  it('reports eval data that is not a list of eval cases', async () => {
    const filePath = await writeAppFile('bad.json', {unexpected: true});

    await expect(loadEvalSetFromFile(filePath, 'chosen_id')).rejects.toThrow(
      'Eval data in the original format must be a JSON array of eval cases.',
    );
  });
});
