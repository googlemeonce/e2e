/**
 * `--step` through the real runner: every step is held until a key answers
 * its prompt. A file-backed config runs it on a worker process, so the
 * `step-gate` and `step-go` messages cross a real IPC channel; the supplied
 * config runs it in-process, where they do not.
 */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/run/events.ts';
import { STEP_KEYS, type StepInput } from '../../src/run/step-gate.ts';
import {
  resultByTitle,
  runProject,
  runProjectWithConfigFile,
  workerFakeConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('walks two steps', async ({ app }) => {
  await app.open();
  await app.open();
});

test('outlasts its own timeout while a step is held', { timeout: 300 }, async ({ app }) => {
  await app.open();
});
`;

const FILES = { 'tests/step.e2e.ts': SUITE };

interface Stepped {
  readonly outcome: RunOutcome;
  readonly project: FixtureProject;
  /** The prompts, in the order they were printed. */
  readonly prompts: string[];
}

/** A terminal that answers each prompt with `keys[n]` after `delayMs`; the last key repeats. */
async function stepped(
  run: (options: { step: true; stepInput: StepInput; onEvent: (event: RunEvent) => void }) => Promise<{ outcome: RunOutcome; project: FixtureProject }>,
  keys: string,
  delayMs = 200,
): Promise<Stepped> {
  const input = new PassThrough() as PassThrough & StepInput;
  Object.assign(input, { isTTY: true, setRawMode: () => undefined });
  const prompts: string[] = [];
  const result = await run({
    step: true,
    stepInput: input,
    onEvent: (event) => {
      if (event.type !== 'notice' || !event.message.includes(`\n  ${STEP_KEYS}`)) return;
      const key = keys[Math.min(prompts.length, keys.length - 1)]!;
      prompts.push(event.message.split('\n')[0]!);
      setTimeout(() => input.write(key), delayMs);
    },
  });
  return { ...result, prompts };
}

describe('--step', () => {
  let project: FixtureProject | undefined;

  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it('runs the first step on its own, then holds each step until c, naming it with its source line, on a worker process', async () => {
    const result = await stepped(
      (runOptions) => runProjectWithConfigFile(FILES, { configSource: workerFakeConfigSource(3), runOptions }),
      'c',
    );
    project = result.project;
    expect(result.outcome.exitCode).toBe(0);
    expect(result.prompts).toEqual([
      'step 2: app.open /  (tests/step.e2e.ts:5)',
      'step 1: app.open /  (tests/step.e2e.ts:9)',
    ]);
    expect(resultByTitle(result.outcome, 'walks two steps').status).toBe('passed');
  }, 120_000);

  it('runs on one worker process whatever the config says', async () => {
    const pids = path.join(tmpdir(), `e2e-step-pids-${String(process.pid)}.txt`);
    rmSync(pids, { force: true });
    process.env['STEP_PID_FILE'] = pids;
    try {
      const body = (name: string): string => `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';

test('${name}', async ({ app }) => {
  appendFileSync(process.env.STEP_PID_FILE!, String(process.pid) + '\\n');
  await app.open();
});
`;
      const result = await stepped(
        (runOptions) =>
          runProjectWithConfigFile(
            { 'tests/a.e2e.ts': body('a'), 'tests/b.e2e.ts': body('b'), 'tests/c.e2e.ts': body('c') },
            { configSource: workerFakeConfigSource(3), runOptions },
          ),
        'c',
      );
      project = result.project;
      expect(result.outcome.exitCode).toBe(0);
      const seen = readFileSync(pids, 'utf8').trim().split('\n');
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(1);
    } finally {
      delete process.env['STEP_PID_FILE'];
      rmSync(pids, { force: true });
    }
  }, 120_000);

  it('has no test timeout while a step is held', async () => {
    const result = await stepped(
      (runOptions) => runProjectWithConfigFile(FILES, { configSource: workerFakeConfigSource(1), runOptions }),
      'c',
      700,
    );
    project = result.project;
    expect(resultByTitle(result.outcome, 'outlasts its own timeout while a step is held').status).toBe('passed');
  }, 120_000);

  it('runs the rest without stopping after r', async () => {
    const result = await stepped(
      (runOptions) => runProjectWithConfigFile(FILES, { configSource: workerFakeConfigSource(1), runOptions }),
      'r',
    );
    project = result.project;
    expect(result.prompts).toHaveLength(1);
    expect(result.outcome.exitCode).toBe(0);
    expect(result.outcome.results.map((entry) => entry.status)).toEqual(['passed', 'passed']);
  }, 120_000);

  it('stops the run at the held step after q, interrupting the test and skipping the rest', async () => {
    const result = await stepped(
      (runOptions) => runProjectWithConfigFile(FILES, { configSource: workerFakeConfigSource(1), runOptions }),
      'q',
    );
    project = result.project;
    expect(result.prompts).toHaveLength(1);
    expect(result.outcome.exitCode).toBe(130);
    expect(resultByTitle(result.outcome, 'walks two steps').status).toBe('interrupted');
    expect(resultByTitle(result.outcome, 'outlasts its own timeout while a step is held').status).toBe('skipped');
  }, 120_000);

  it('works in-process too', async () => {
    const result = await stepped((runOptions) => runProject(FILES, { runOptions }), 'c');
    project = result.project;
    expect(result.outcome.exitCode).toBe(0);
    expect(result.prompts).toHaveLength(2);
  }, 120_000);
});
