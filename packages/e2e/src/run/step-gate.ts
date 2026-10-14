/**
 * `--step`: the runner's side of the step prompt. A worker holds each step
 * until the gate answers; the gate prints the step, waits for the person at
 * the terminal, and lets it through. The run's first step goes through on its
 * own, since it is what opens the app; every later step waits for a key,
 * except a setup test's and a retry's, which go through unless the person
 * asked to hold them. Only the runner process owns the terminal, so every
 * worker asks here, one prompt at a time.
 */

import { emitKeypressEvents, type Key } from 'node:readline';
import type { StepGateRequest } from './worker/protocol.ts';

/** The stream the gate reads keys from: a terminal, or a stand-in for one. */
export interface StepInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** What a person (or the inspector) can ask of the gate. */
export type StepAction = 'next' | 'test' | 'rest' | 'stop';

/** Which steps wait for a key beyond the ones that always do: a setup test's, and a retry's. */
export interface StepHold {
  readonly setup: boolean;
  readonly retries: boolean;
}

/** Why a step went through without waiting. */
export type StepAuto = 'first' | 'setup' | 'retry' | 'test' | 'rest';

/** What happened at the gate, for the inspector to follow. */
export type StepGateEvent =
  | { readonly kind: 'arrive'; readonly request: StepGateRequest; readonly targetName: string; readonly waits: boolean; readonly auto?: StepAuto }
  | { readonly kind: 'release'; readonly request: StepGateRequest }
  | { readonly kind: 'test' }
  | { readonly kind: 'free' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'hold'; readonly hold: StepHold };

export interface StepGateOptions {
  /** Where keys come from; without it the gate answers only to `press`, as with the inspector and no terminal. */
  readonly input?: StepInput | undefined;
  /** Hears every step that arrives and how each is answered. */
  readonly observe?: ((event: StepGateEvent) => void) | undefined;
  /** Prints one line above the run's live output, for the target the step belongs to. */
  readonly say: (targetName: string, line: string) => void;
  /** Interrupts the run the way Ctrl-C does outside raw mode, which delivers no signal. */
  readonly interrupt: () => void;
  /**
   * How long after a prompt is printed that keys are ignored (default 150).
   * A key typed before the prompt was on screen, or a held Enter repeating,
   * would answer a step the person has not seen.
   */
  readonly settleMs?: number;
}

export interface StepGate {
  /** Holds one step: resolves true when the person lets it run, false when they stop the run. */
  ask(request: StepGateRequest, targetName: string): Promise<boolean>;
  /**
   * Answers the step on screen as a key would: `next` runs it, `test` runs
   * the rest of its test and holds again at the next one, `rest` runs the
   * rest of the run without stopping, `stop` ends the run. False when no step
   * is held.
   */
  press(action: StepAction): boolean;
  /** Which steps wait beyond the ones that always do; none of a setup test's or a retry's by default. */
  readonly hold: StepHold;
  /** Changes which steps wait, for the steps that arrive from now on. */
  setHold(change: Partial<StepHold>): StepHold;
  /** Lets every held and later step through or stops them all, as the run ending does; the terminal is given back. */
  release(go: boolean): void;
  /** Gives the terminal back. */
  close(): void;
}

/** How long a prompt ignores keys after it is printed; see `StepGateOptions.settleMs`. */
const DEFAULT_SETTLE_MS = 150;

/** The longest a step's label runs in a prompt line before it is cut. */
const LABEL_COLUMNS = 100;

/** The prompt line for one held step. */
export function describeStep(request: StepGateRequest): string {
  const label = request.label.replace(/\s+/g, ' ').trim();
  const shown = label.length > LABEL_COLUMNS ? `${label.slice(0, LABEL_COLUMNS - 1)}…` : label;
  const where = request.source === undefined ? '' : `  (${request.source})`;
  return `step ${request.index + 1}: ${request.api}${shown === '' ? '' : ` ${shown}`}${where}`;
}

/** The keys under a prompt. */
export const STEP_KEYS = 'c runs it · t finishes this test · r runs the rest · q stops the run';

/** The line for the run's first step, which runs without a key. */
export function describeFirstStep(request: StepGateRequest): string {
  return `${describeStep(request)}  · runs now; later steps wait for a key`;
}

/** One run of one test on one target: what "finish this test" lasts for, retries included. */
function testKey(request: StepGateRequest, targetName: string): string {
  return `${targetName}\u0000${request.testId}\u0000${request.agent}\u0000${String(request.repeat)}`;
}

/** The gate for a run that steps. */
export function createStepGate(options: StepGateOptions): StepGate {
  const { input } = options;
  const observe = options.observe ?? (() => undefined);
  let hold: StepHold = { setup: false, retries: false };
  /** The test the person chose to finish: its steps go through until another test's step arrives. */
  let finishing: string | undefined;
  /** The prompts waiting for their turn, oldest first; the first is the one on screen. */
  const queue: { readonly request: StepGateRequest; readonly targetName: string; readonly settle: (go: boolean) => void }[] = [];
  /** Set once the person chose `c` or `q`, or the run ended: later steps are answered at once. */
  let decided: boolean | undefined;
  let listening = false;
  /** Keys before this instant are ignored: they were typed before the prompt in front of the person was there. */
  let armedAt = 0;

  const press = (action: StepAction): boolean => {
    const head = queue[0];
    if (head === undefined) return false;
    if (action === 'next') {
      queue.shift();
      observe({ kind: 'release', request: head.request });
      head.settle(true);
      prompt();
    } else if (action === 'test') {
      finishing = testKey(head.request, head.targetName);
      observe({ kind: 'test' });
      // Every step of that test already waiting goes through; another target's stays held.
      for (const held of queue.splice(0)) {
        if (testKey(held.request, held.targetName) === finishing) {
          observe({ kind: 'release', request: held.request });
          held.settle(true);
        } else queue.push(held);
      }
      prompt();
    } else if (action === 'rest') {
      observe({ kind: 'free' });
      release(true);
    } else {
      // The interrupt goes first: a worker told to stop the step before it hears the run is interrupted
      // reports a failed test, not an interrupted one.
      options.interrupt();
      release(false);
    }
    return true;
  };

  const onKey = (_text: string | undefined, key: Key | undefined): void => {
    if (key === undefined) return;
    const interrupts = key.ctrl === true && (key.name === 'c' || key.name === 'd');
    if (queue[0] === undefined) {
      // A step is running, or a test is being finished, with the terminal still in raw mode, where Ctrl-C
      // delivers no signal. It must still end the run; handing the terminal back makes a second one a real SIGINT.
      if (interrupts) {
        options.interrupt();
        release(false);
      }
      return;
    }
    if (Date.now() < armedAt) return;
    if (key.name === 'c' && key.ctrl !== true) press('next');
    else if (key.name === 't' && key.ctrl !== true) press('test');
    else if (key.name === 'r' && key.ctrl !== true) press('rest');
    else if (key.name === 'q' || key.name === 'escape' || interrupts) press('stop');
  };

  /** Starts reading keys; raw mode makes each press arrive alone, with no Enter to end a line. */
  const listen = (): void => {
    if (listening || input === undefined) return;
    listening = true;
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on('keypress', onKey);
    (input as { resume?: () => void }).resume?.();
  };

  const close = (): void => {
    if (!listening || input === undefined) return;
    listening = false;
    input.off('keypress', onKey);
    input.setRawMode?.(false);
    (input as { pause?: () => void }).pause?.();
  };

  /** Prints the prompt for the step at the head of the queue. */
  const prompt = (): void => {
    const head = queue[0];
    if (head === undefined) return;
    armedAt = Date.now() + (options.settleMs ?? DEFAULT_SETTLE_MS);
    options.say(head.targetName, `${describeStep(head.request)}\n  ${STEP_KEYS}`);
  };

  /** Whether the run's first step has been let through; it opens the app and needs no key. */
  let started = false;

  const release = (go: boolean): void => {
    if (!go) observe({ kind: 'stop' });
    decided = go;
    for (const held of queue.splice(0)) held.settle(go);
    close();
  };

  return {
    ask(request, targetName) {
      if (decided !== undefined) {
        if (decided) observe({ kind: 'arrive', request, targetName, waits: false, auto: 'rest' });
        return Promise.resolve(decided);
      }
      if (!started) {
        started = true;
        observe({ kind: 'arrive', request, targetName, waits: false, auto: 'first' });
        options.say(targetName, describeFirstStep(request));
        return Promise.resolve(true);
      }
      const key = testKey(request, targetName);
      const auto: StepAuto | undefined =
        request.setup && !hold.setup ? 'setup' : request.attempt > 0 && !hold.retries ? 'retry' : finishing === key ? 'test' : undefined;
      // Another test's step ends the one the person chose to finish.
      if (finishing !== undefined && finishing !== key && !request.setup) finishing = undefined;
      if (auto !== undefined) {
        observe({ kind: 'arrive', request, targetName, waits: false, auto });
        return Promise.resolve(true);
      }
      return new Promise<boolean>((settle) => {
        queue.push({ request, targetName, settle });
        observe({ kind: 'arrive', request, targetName, waits: true });
        listen();
        if (queue.length === 1) prompt();
      });
    },
    press,
    get hold() {
      return hold;
    },
    setHold(change) {
      hold = { ...hold, ...change };
      observe({ kind: 'hold', hold });
      return hold;
    },
    release,
    close,
  };
}
