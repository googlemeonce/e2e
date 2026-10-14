/** StepRecorder `beforeStep`: a step held before its body runs, for `--step`. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestError } from '../../src/internal/errors.ts';
import { StepRecorder, type StepGateInfo, type StepProgress } from '../../src/run/steps.ts';

function hold(): { promise: Promise<void>; release: () => void; reject: (cause: Error) => void } {
  let release!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  return { promise, release, reject };
}

describe('StepRecorder beforeStep', () => {
  it('publishes the step, holds its body until released, then runs it', async () => {
    const heard: StepProgress[] = [];
    const held = hold();
    const asked: StepGateInfo[] = [];
    const steps = new StepRecorder('attempt', {
      projectRoot: path.join(process.cwd(), 'tests'),
      onProgress: (progress) => heard.push(progress),
      beforeStep: (step) => {
        asked.push(step);
        return held.promise;
      },
    });
    let ran = false;
    const step = steps.run('app', 'app.open', '/todos', async () => {
      ran = true;
      return 'opened';
    });
    await Promise.resolve();
    expect(heard.map((progress) => progress.phase)).toEqual(['start']);
    expect(ran).toBe(false);
    expect(asked).toEqual([{ index: 0, api: 'app.open', label: '/todos', source: expect.stringContaining('step-hold.test.ts:') }]);

    held.release();
    expect(await step).toBe('opened');
    expect(ran).toBe(true);
    expect(heard.map((progress) => progress.phase)).toEqual(['start', 'end']);
    expect(steps.all()[0]?.status).toBe('passed');
  });

  it('times and dates the step from when it was let go, not from when it was held', async () => {
    const held = hold();
    const steps = new StepRecorder('attempt', { beforeStep: () => held.promise });
    const step = steps.run('app', 'app.open', '/', async () => {});
    const heldAt = steps.all()[0]!.startedAt;
    await new Promise((resolve) => setTimeout(resolve, 60));
    held.release();
    await step;
    const record = steps.all()[0]!;
    expect(Date.parse(record.startedAt)).toBeGreaterThanOrEqual(Date.parse(heldAt) + 50);
    expect(record.durationMs).toBeLessThan(50);
  });

  it('fails the step, without running its body, when the hold rejects', async () => {
    const held = hold();
    const steps = new StepRecorder('attempt', { beforeStep: () => held.promise });
    let ran = false;
    const step = steps.run('app', 'app.open', '/', async () => {
      ran = true;
    });
    held.reject(new TestError('CANCELLED', 'stopped at the step prompt'));
    await expect(step).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ran).toBe(false);
    expect(steps.all()[0]?.status).toBe('cancelled');
  });

  it('cancels a step held when the attempt aborts', async () => {
    const abort = new AbortController();
    const steps = new StepRecorder('attempt', { signal: abort.signal, beforeStep: () => new Promise<void>(() => undefined) });
    const step = steps.run('app', 'app.open', '/', async () => {});
    abort.abort();
    await expect(step).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(steps.all()[0]?.status).toBe('cancelled');
  });

  it('holds every step, one after another', async () => {
    const order: string[] = [];
    const steps = new StepRecorder('attempt', {
      beforeStep: async (step) => {
        order.push(`hold ${step.index}`);
      },
    });
    await steps.run('app', 'app.open', '/', async () => void order.push('run 0'));
    await steps.run('app', 'app.back', '', async () => void order.push('run 1'));
    expect(order).toEqual(['hold 0', 'run 0', 'hold 1', 'run 1']);
  });

  it('does not hold anything without the hook', async () => {
    const steps = new StepRecorder('attempt');
    await expect(steps.run('app', 'app.open', '/', async () => 'ok')).resolves.toBe('ok');
  });
});
