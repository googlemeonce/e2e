/** The `--step` gate: the first step runs on its own, then one prompt at a time, `c`, `r`, `q`, and giving the terminal back. */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createStepGate, describeFirstStep, describeStep, STEP_KEYS, type StepInput } from '../../src/run/step-gate.ts';
import type { StepGateRequest } from '../../src/run/worker/protocol.ts';

function terminal(): StepInput & PassThrough & { raw: boolean[] } {
  const input = new PassThrough() as StepInput & PassThrough & { raw: boolean[] };
  Object.assign(input, { isTTY: true, raw: [] as boolean[], setRawMode: (mode: boolean) => void input.raw.push(mode) });
  return input;
}

const request = (index: number, extra: Partial<StepGateRequest> = {}): StepGateRequest => ({
  testId: 't',
  agent: 'default',
  repeat: 0,
  index,
  attempt: 0,
  setup: false,
  api: 'app.open',
  label: '/todos',
  source: 'tests/a.e2e.ts:5',
  ...extra,
});

/** Lets pending stream events and promise callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The same, with the observer in hand. */
async function startedObserved() {
  const input = terminal();
  const say = vi.fn();
  const observe = vi.fn();
  const gate = createStepGate({ input, say, interrupt: vi.fn(), observe, settleMs: 0 });
  expect(await gate.ask(request(0), 'web')).toBe(true);
  say.mockClear();
  observe.mockClear();
  return { input, say, observe, gate };
}

/** A gate whose first step has already gone through, as in a run past its opening step. */
async function started() {
  const input = terminal();
  const say = vi.fn();
  const interrupt = vi.fn();
  const gate = createStepGate({ input, say, interrupt, settleMs: 0 });
  expect(await gate.ask(request(0, { api: 'app.open' }), 'web')).toBe(true);
  say.mockClear();
  return { input, say, interrupt, gate };
}

describe('describeStep', () => {
  it('names the step, its place, and its source line', () => {
    expect(describeStep(request(2))).toBe('step 3: app.open /todos  (tests/a.e2e.ts:5)');
    expect(STEP_KEYS).toBe('c runs it · t finishes this test · r runs the rest · q stops the run');
    expect(describeFirstStep(request(0))).toBe('step 1: app.open /todos  (tests/a.e2e.ts:5)  · runs now; later steps wait for a key');
  });

  it('collapses whitespace, cuts a long label, and leaves out what it does not know', () => {
    const long = describeStep(request(0, { label: `a\n  b ${'x'.repeat(200)}`, source: undefined }));
    expect(long).toMatch(/^step 1: app\.open a b x+…$/);
    expect(long.length).toBeLessThan(130);
    expect(describeStep(request(0, { label: '', source: undefined }))).toBe('step 1: app.open');
  });
});

describe('createStepGate', () => {
  it('lets the first step through on its own, naming it, without taking the terminal', async () => {
    const input = terminal();
    const say = vi.fn();
    const gate = createStepGate({ input, say, interrupt: vi.fn(), settleMs: 0 });
    expect(await gate.ask(request(0), 'web')).toBe(true);
    expect(say).toHaveBeenCalledWith('web', describeFirstStep(request(0)));
    expect(input.raw).toEqual([]);
  });

  it('holds the second step: prints it with the keys and waits for c, with the terminal in raw mode', async () => {
    const { gate, input, say } = await started();
    let answer: boolean | undefined;
    void gate.ask(request(1), 'web').then((go) => (answer = go));
    await settle();
    expect(say).toHaveBeenCalledWith('web', `${describeStep(request(1))}\n  ${STEP_KEYS}`);
    expect(input.raw).toEqual([true]);
    expect(answer).toBeUndefined();

    input.write('c');
    await settle();
    expect(answer).toBe(true);
  });

  it('does not take Enter or any other key for c', async () => {
    const { gate, input } = await started();
    let answer: boolean | undefined;
    void gate.ask(request(1), 'web').then((go) => (answer = go));
    await settle();
    input.write('\r');
    input.write('xyz ');
    await settle();
    expect(answer).toBeUndefined();
  });

  it('prompts for one step at a time, each waiting for its own c', async () => {
    const { gate, input, say } = await started();
    const answers: string[] = [];
    void gate.ask(request(1), 'web').then(() => answers.push('second'));
    void gate.ask(request(2, { api: 'app.back', label: '' }), 'web').then(() => answers.push('third'));
    await settle();
    expect(say).toHaveBeenCalledTimes(1);

    input.write('c');
    await settle();
    expect(answers).toEqual(['second']);
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenLastCalledWith('web', `${describeStep(request(2, { api: 'app.back', label: '' }))}\n  ${STEP_KEYS}`);

    input.write('c');
    await settle();
    expect(answers).toEqual(['second', 'third']);
  });

  it('lets every held and later step through on r, and gives the terminal back', async () => {
    const { gate, input, say } = await started();
    const held = [gate.ask(request(1), 'web'), gate.ask(request(2), 'web')];
    await settle();
    input.write('r');
    expect(await Promise.all(held)).toEqual([true, true]);
    expect(await gate.ask(request(3), 'web')).toBe(true);
    expect(say).toHaveBeenCalledTimes(1);
    expect(input.raw).toEqual([true, false]);
  });

  it.each([['q'], ['\u001b'], ['\u0003'], ['\u0004']])('stops the run on %j: the step, the queue and later steps are refused, and the run is interrupted', async (key) => {
    const { gate, input, interrupt } = await started();
    const held = [gate.ask(request(1), 'web'), gate.ask(request(2), 'web')];
    await settle();
    input.write(key);
    await settle();
    expect(await Promise.all(held)).toEqual([false, false]);
    expect(await gate.ask(request(3), 'web')).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(input.raw).toEqual([true, false]);
  });

  it('ignores keys that arrive before the prompt has settled, then answers on the next one', async () => {
    const input = terminal();
    const stepGate = createStepGate({ input, say: vi.fn(), interrupt: vi.fn(), settleMs: 60 });
    await stepGate.ask(request(0), 'web');
    let answer: boolean | undefined;
    void stepGate.ask(request(1), 'web').then((go) => (answer = go));
    await settle();
    input.write('c');
    await settle();
    expect(answer).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 80));
    input.write('c');
    await settle();
    expect(answer).toBe(true);
  });

  it('settles again for every prompt, so a held c answers one step', async () => {
    const input = terminal();
    const say = vi.fn();
    const stepGate = createStepGate({ input, say, interrupt: vi.fn(), settleMs: 60 });
    await stepGate.ask(request(0), 'web');
    say.mockClear();
    const answers: number[] = [];
    void stepGate.ask(request(1), 'web').then(() => answers.push(1));
    void stepGate.ask(request(2), 'web').then(() => answers.push(2));
    await new Promise((resolve) => setTimeout(resolve, 80));
    input.write('ccc');
    await settle();
    expect(answers).toEqual([1]);
    expect(say).toHaveBeenCalledTimes(2);
  });

  it('answers every held step when the run releases it, and gives the terminal back', async () => {
    const { gate, input } = await started();
    const held = gate.ask(request(1), 'web');
    await settle();
    gate.release(false);
    expect(await held).toBe(false);
    expect(await gate.ask(request(2), 'web')).toBe(false);
    expect(input.raw).toEqual([true, false]);
  });

  describe('finishing a test', () => {
    const other = { testId: 't2' };

    it('lets the rest of the test through on t, and holds again at the next test\'s first step', async () => {
      const { gate, input, say } = await started();
      let second: boolean | undefined;
      void gate.ask(request(1), 'web').then((go) => (second = go));
      await settle();
      input.write('t');
      await settle();
      expect(second).toBe(true);

      expect(await gate.ask(request(2), 'web')).toBe(true);
      expect(await gate.ask(request(3), 'web')).toBe(true);

      let next: boolean | undefined;
      say.mockClear();
      void gate.ask(request(0, other), 'web').then((go) => (next = go));
      await settle();
      expect(next).toBeUndefined();
      expect(say).toHaveBeenCalledWith('web', `${describeStep(request(0, other))}\n  ${STEP_KEYS}`);

      input.write('c');
      await settle();
      expect(next).toBe(true);
      // The test after it is held for good, until the person finishes that one too.
      let after: boolean | undefined;
      void gate.ask(request(1, other), 'web').then((go) => (after = go));
      await settle();
      expect(after).toBeUndefined();
    });

    it('counts a retry and a repeat as the test, or as another, as they are', async () => {
      const { gate } = await started();
      let held: boolean | undefined;
      void gate.ask(request(1), 'web').then((go) => (held = go));
      await settle();
      expect(gate.press('test')).toBe(true);
      await settle();
      expect(held).toBe(true);
      expect(await gate.ask(request(0, { attempt: 1 }), 'web')).toBe(true);

      let repeated: boolean | undefined;
      void gate.ask(request(0, { repeat: 1 }), 'web').then((go) => (repeated = go));
      await settle();
      expect(repeated).toBeUndefined();
    });

    it('lets through only that test\'s held steps, leaving another target\'s held', async () => {
      const { gate, observe } = await startedObserved();
      void gate.ask(request(1), 'web');
      const elsewhere = gate.ask(request(0, other), 'worker-2');
      let answer: boolean | undefined;
      void elsewhere.then((go) => (answer = go));
      await settle();
      gate.press('test');
      await settle();
      expect(answer).toBeUndefined();
      expect(observe).toHaveBeenCalledWith({ kind: 'test' });
    });

    it('does not carry a finished test over to the same test on another target', async () => {
      const { gate, input } = await started();
      void gate.ask(request(1), 'web');
      await settle();
      input.write('t');
      await settle();
      expect(await gate.ask(request(2), 'web')).toBe(true);

      let elsewhere: boolean | undefined;
      void gate.ask(request(0), 'firefox').then((go) => (elsewhere = go));
      await settle();
      expect(elsewhere).toBeUndefined();
    });

    it('does nothing when no step is held', async () => {
      const { gate } = await started();
      expect(gate.press('test')).toBe(false);
    });
  });

  describe('setup tests and retries', () => {
    it('lets a setup test\'s steps and a retry\'s through by default, saying why to the observer', async () => {
      const { gate, observe, say } = await startedObserved();
      expect(await gate.ask(request(1, { setup: true }), 'web')).toBe(true);
      expect(await gate.ask(request(0, { attempt: 1 }), 'web')).toBe(true);
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: 'arrive', waits: false, auto: 'setup' }));
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: 'arrive', waits: false, auto: 'retry' }));
      expect(say).not.toHaveBeenCalled();
    });

    it('holds them once asked to, for the steps that arrive from then on', async () => {
      const { gate, observe } = await startedObserved();
      expect(gate.hold).toEqual({ setup: false, retries: false });
      expect(gate.setHold({ setup: true })).toEqual({ setup: true, retries: false });
      expect(observe).toHaveBeenCalledWith({ kind: 'hold', hold: { setup: true, retries: false } });

      let setup: boolean | undefined;
      void gate.ask(request(0, { setup: true }), 'web').then((go) => (setup = go));
      await settle();
      expect(setup).toBeUndefined();
      gate.press('next');
      await settle();
      expect(setup).toBe(true);

      expect(await gate.ask(request(0, { attempt: 1 }), 'web')).toBe(true);
      gate.setHold({ retries: true });
      let retry: boolean | undefined;
      void gate.ask(request(0, { attempt: 2 }), 'web').then((go) => (retry = go));
      await settle();
      expect(retry).toBeUndefined();
      expect(gate.hold).toEqual({ setup: true, retries: true });
    });

    it('lets the run\'s first step through whatever it is, and keeps its own rule for the setup that follows', async () => {
      const input = terminal();
      const gate = createStepGate({ input, say: vi.fn(), interrupt: vi.fn(), settleMs: 0 });
      gate.setHold({ setup: true });
      expect(await gate.ask(request(0, { setup: true }), 'web')).toBe(true);
      let next: boolean | undefined;
      void gate.ask(request(1, { setup: true }), 'web').then((go) => (next = go));
      await settle();
      expect(next).toBeUndefined();
    });

    it('does not end a chosen test\'s finish because a setup step ran between', async () => {
      const { gate } = await started();
      void gate.ask(request(1), 'web');
      await settle();
      gate.press('test');
      expect(await gate.ask(request(0, { testId: 'setup-x', setup: true }), 'web')).toBe(true);
      expect(await gate.ask(request(2), 'web')).toBe(true);
    });
  });

  it('closes without ever having asked, and closing twice is harmless', () => {
    const { input } = { input: terminal() };
    const stepGate = createStepGate({ input, say: vi.fn(), interrupt: vi.fn() });
    stepGate.close();
    stepGate.close();
    expect(input.raw).toEqual([]);
  });
});
