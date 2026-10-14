/**
 * `--inspect` through the real runner and a worker process: the inspector is
 * served, shows the step held, and its buttons answer the gate. The tests
 * press them over HTTP, as the page's script does.
 */

import { rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/run/events.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerFakeConfigSource,
  type FixtureProject,
} from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('walks three steps', async ({ app }) => {
  await app.open();
  await app.open();
  await app.open();
});

test('never gets to run', async ({ app }) => {
  await app.open();
});
`;

interface UiState {
  readonly phase: string;
  readonly steps: readonly {
    readonly n: number;
    readonly status: string;
    readonly file?: string;
    readonly line?: number;
    readonly testId: string;
    readonly testKey: string;
    readonly attempt: number;
    readonly setup: boolean;
    readonly auto?: string;
  }[];
  readonly tests: readonly { readonly title: string; readonly status: string; readonly target: string }[];
  readonly total?: number;
  readonly current?: number;
}

const FLAKY = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('fails once, then passes', async ({ app }) => {
  await app.open();
  await app.open();
  if (!existsSync(process.env.STEP_RETRY_FILE!)) {
    writeFileSync(process.env.STEP_RETRY_FILE!, 'failed once');
    throw new Error('the first attempt fails');
  }
});
`;

const WITH_SETUP = `import { test } from 'e2e';

test.setup('signs in', { sessions: ['a'] }, async ({ app, session }) => {
  await app.open();
  await app.open();
  await session.save('a');
});

test('uses the session', { session: 'a' }, async ({ app }) => {
  await app.open();
  await app.open();
});
`;

/** Calls `onState` for every state the page's event stream carries, until closed. */
function follow(url: string, onState: (state: UiState) => void): () => void {
  let buffer = '';
  const req = http.get(`${url}events`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        onState(JSON.parse(buffer.slice('data: '.length, end)) as UiState);
        buffer = buffer.slice(end + 2);
      }
    });
  });
  req.on('error', () => undefined);
  return () => req.destroy();
}

function press(url: string, action: string | Record<string, boolean>, route = 'press'): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify(typeof action === 'string' ? { action } : action);
    const req = http.request(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.end(body);
  });
}

describe('--inspect', () => {
  let project: FixtureProject | undefined;

  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  /** Runs the suite with the page; `onPaused` decides what the person presses at each held step. */
  async function stepped(
    onPaused: (state: UiState, url: string) => string | undefined,
    options: { suite?: string; retries?: number; hold?: Record<string, boolean>; configSource?: string } = {},
  ) {
    const phases: string[] = [];
    const states: UiState[] = [];
    let page: string | undefined;
    let stop: (() => void) | undefined;
    const pressed = new Set<string>();
    const result = await runProjectWithConfigFile({ 'tests/inspect.e2e.ts': options.suite ?? SUITE }, {
      configSource: options.configSource ?? workerFakeConfigSource(3),
      runOptions: {
        step: true,
        inspect: true,
        ...(options.retries === undefined ? {} : { retries: options.retries }),
        onEvent: (event: RunEvent) => {
          if (event.type !== 'notice' || page !== undefined) return;
          const match = /inspector: (\S+)/u.exec(event.message);
          if (match === null) return;
          const url = match[1]!;
          page = url;
          if (options.hold !== undefined) void press(url, options.hold, 'hold');
          stop = follow(url, (state) => {
            phases.push(state.phase);
            states.push(state);
            if (state.phase !== 'paused') return;
            const key = `${String(state.steps.length)}`;
            if (pressed.has(key)) return;
            pressed.add(key);
            const action = onPaused(state, url);
            if (action !== undefined) void press(url, action);
          });
        },
      },
    });
    // The server writes its last state as the run ends; let the stream deliver it before listening stops.
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop?.();
    project = result.project;
    return { ...result, page, phases, states };
  }

  it('is served while the run goes, and its next button runs one step at a time', async () => {
    const heldAt: number[] = [];
    const { outcome, page, phases } = await stepped((state) => {
      heldAt.push(state.steps.length);
      return state.steps.length < 99 ? 'next' : undefined;
    });
    expect(page).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/u);
    expect(outcome.exitCode).toBe(0);
    // Step 1 ran on its own; each later step was held, and the page said so before it ran.
    expect(heldAt).toEqual([2, 3, 4]);
    expect(phases).toContain('paused');
    expect(phases.at(-1)).toBe('finished');
  }, 120_000);

  it('stops the run from its stop button', async () => {
    const { outcome, phases } = await stepped((state) => (state.steps.length === 2 ? 'stop' : undefined));
    expect(outcome.exitCode).toBe(130);
    expect(resultByTitle(outcome, 'walks three steps').status).toBe('interrupted');
    expect(resultByTitle(outcome, 'never gets to run').status).toBe('skipped');
    expect(phases).toContain('stopped');
  }, 120_000);

  it('runs the rest from its run-the-rest button', async () => {
    const { outcome } = await stepped((state) => (state.steps.length === 2 ? 'rest' : undefined));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);
  }, 120_000);

  it('finishes a test on its finish button, then holds again at the next test', async () => {
    const heldAt: number[] = [];
    const { outcome, states } = await stepped((state) => {
      heldAt.push(state.steps.length);
      return state.steps.length === 2 ? 'test' : 'next';
    });
    expect(outcome.exitCode).toBe(0);
    // Step 1 ran on its own and step 2 was held; the rest of that test went through, and the next test held again.
    expect(heldAt).toEqual([2, 4]);
    const last = states.at(-1)!;
    expect(last.steps.slice(0, 3).map((step) => step.auto)).toEqual(['first', undefined, 'test']);
    expect(last.steps[3]!.auto).toBeUndefined();
    expect(last.tests.map((test) => test.status)).toEqual(['passed', 'passed']);
    expect(last.total).toBe(2);
  }, 120_000);

  describe('retries', () => {
    const retryFile = path.join(tmpdir(), `e2e-inspector-retry-${String(process.pid)}.txt`);

    afterEach(() => {
      delete process.env['STEP_RETRY_FILE'];
      rmSync(retryFile, { force: true });
    });

    it('runs a retry without stopping by default', async () => {
      rmSync(retryFile, { force: true });
      process.env['STEP_RETRY_FILE'] = retryFile;
      const heldAt: number[] = [];
      const { outcome, states } = await stepped(
        (state) => {
          heldAt.push(state.steps.length);
          return 'next';
        },
        { suite: FLAKY, retries: 1 },
      );
      expect(outcome.exitCode).toBe(0);
      expect(heldAt).toEqual([2]);
      const steps = states.at(-1)!.steps;
      expect(steps.map((step) => step.attempt)).toEqual([0, 0, 1, 1]);
      expect(steps.slice(2).map((step) => step.auto)).toEqual(['retry', 'retry']);
    }, 120_000);

    it('holds a retry when asked to', async () => {
      rmSync(retryFile, { force: true });
      process.env['STEP_RETRY_FILE'] = retryFile;
      const heldAt: number[] = [];
      const { outcome } = await stepped(
        (state) => {
          heldAt.push(state.steps.length);
          return 'next';
        },
        { suite: FLAKY, retries: 1, hold: { retries: true } },
      );
      expect(outcome.exitCode).toBe(0);
      expect(heldAt).toEqual([2, 3, 4]);
    }, 120_000);
  });

  describe('setup tests', () => {
    it('runs a setup test without stopping by default, and holds the test that uses its session', async () => {
      const held: { setup: boolean; n: number }[] = [];
      const { outcome, states } = await stepped((state) => {
        const step = state.steps.at(-1)!;
        held.push({ setup: step.setup, n: step.n });
        return 'next';
      }, { suite: WITH_SETUP });
      expect(outcome.exitCode, JSON.stringify(outcome.report.run.errors)).toBe(0);
      expect(held.every((entry) => !entry.setup)).toBe(true);
      const steps = states.at(-1)!.steps;
      const setup = steps.filter((step) => step.setup);
      expect(setup.length).toBeGreaterThan(0);
      expect(setup.slice(1).every((step) => step.auto === 'setup')).toBe(true);
      expect(held.length).toBeGreaterThan(0);
    }, 120_000);

    it('holds a setup test when asked to', async () => {
      const held: boolean[] = [];
      const { outcome } = await stepped((state) => {
        held.push(state.steps.at(-1)!.setup);
        return 'next';
      }, { suite: WITH_SETUP, hold: { setup: true } });
      expect(outcome.exitCode).toBe(0);
      expect(held).toContain(true);
    }, 120_000);
  });

  it('keeps two targets that run the same test apart, one after the other', async () => {
    const configSource = `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [
    { name: 'one', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
    { name: 'two', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
  ],
} satisfies E2EConfig;
`;
    const { states, outcome } = await stepped((state) => (state.current === undefined ? undefined : 'next'), { configSource, suite: SUITE });
    expect(outcome.exitCode).toBe(0);
    const last = states.at(-1)!;
    // Two tests on two targets: four test runs, each its own group, and the page counts all four.
    expect(last.total).toBe(4);
    expect(last.tests).toHaveLength(4);
    expect(last.tests.map((test) => test.target).toSorted()).toEqual(['one', 'one', 'two', 'two']);
    expect(new Set(last.steps.map((step) => step.testKey)).size).toBe(4);
    expect(last.tests.every((test) => test.status === 'passed')).toBe(true);
  }, 120_000);

  it('names each step by its file and line', async () => {
    const seen: { file?: string; line?: number }[] = [];
    await stepped((state) => {
      const step = state.steps.at(-1);
      if (step !== undefined) seen.push({ ...(step.file === undefined ? {} : { file: step.file }), ...(step.line === undefined ? {} : { line: step.line }) });
      return 'next';
    });
    expect(seen).toEqual([
      { file: 'tests/inspect.e2e.ts', line: 5 },
      { file: 'tests/inspect.e2e.ts', line: 6 },
      { file: 'tests/inspect.e2e.ts', line: 10 },
    ]);
  }, 120_000);
});
