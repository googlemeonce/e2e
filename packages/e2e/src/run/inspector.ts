/**
 * The inspector for `--inspect`: a small local web server that shows the test
 * file with the line about to run, the steps so far, and the buttons that
 * answer the step gate. It reads only what the run already reports and can
 * do nothing but press the gate's three keys.
 *
 * Bound to loopback on a random port, under a random token in the path, with
 * the Host and Origin of every request checked, so a page the person visits
 * cannot reach it and another user's process cannot guess it.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { RunEvent } from './events.ts';
import { INSPECTOR_PAGE } from './inspector-page.ts';
import type { StepAction, StepAuto, StepGate, StepGateEvent, StepHold } from './step-gate.ts';

/** How a step stands on the page. */
type UiStepStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'cancelled' | 'blocked' | 'timed-out';

interface UiStep {
  readonly n: number;
  readonly testId: string;
  /** The test run the step belongs to: its target and id, with the agent and the repeat. */
  readonly testKey: string;
  readonly test: string;
  /** Which attempt of the test this is, from 0; above 0 is a retry. */
  readonly attempt: number;
  readonly setup: boolean;
  /** Why the step went through without waiting, when it did. */
  auto?: StepAuto;
  readonly target: string;
  readonly api: string;
  readonly label: string;
  /** Project-relative POSIX path and line, when the call site is known. */
  readonly file?: string;
  readonly line?: number;
  status: UiStepStatus;
  durationMs?: number;
  error?: string;
}

/** One test run, for the page's overview. */
interface UiTest {
  readonly key: string;
  readonly target: string;
  readonly title: string;
  readonly file: string;
  /** `running` until its result arrives, then the result's status. */
  status: 'running' | 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
}

interface UiState {
  phase: 'starting' | 'running' | 'paused' | 'finished' | 'stopped';
  steps: UiStep[];
  /** The tests that have started, in order, and how many the run has in all. */
  tests: UiTest[];
  total?: number;
  /** Index in `steps` of the step held or running. */
  current?: number;
  /** Whether the rest of the run goes without stopping (`r`). */
  free: boolean;
  /** Whether the rest of the current test goes without stopping (`t`). */
  finishing: boolean;
  /** Which steps wait beyond the ones that always do. */
  hold: StepHold;
}

export interface Inspector {
  /** The page's address, token included. */
  readonly url: string;
  /** Feeds the run's events in. */
  onRunEvent(event: RunEvent): void;
  /** Feeds the gate's events in. */
  onGateEvent(event: StepGateEvent): void;
  close(): Promise<void>;
}

export interface InspectorOptions {
  /** Test files are read from under here, and only the ones a step names. */
  readonly projectRoot: string;
  readonly gate: Pick<StepGate, 'press' | 'setHold' | 'hold'>;
  /** How many tests the run has, announced before this server started. */
  readonly total?: number | undefined;
}

/** The largest test file the page will serve. */
const MAX_SOURCE_BYTES = 1_000_000;
const ACTIONS: ReadonlySet<string> = new Set<StepAction>(['next', 'test', 'rest', 'stop']);
const MAX_BODY_BYTES = 1024;

/** Splits `tests/a.e2e.ts:12` into its file and line. */
function splitSource(source: string | undefined): { file?: string; line?: number } {
  if (source === undefined) return {};
  const match = /^(.*):(\d+)$/u.exec(source);
  return match === null ? { file: source } : { file: match[1]!, line: Number(match[2]) };
}

/** Starts the inspector's server. */
export async function startInspector(options: InspectorOptions): Promise<Inspector> {
  const token = randomBytes(16).toString('hex');
  const state: UiState = {
    phase: 'starting',
    steps: [],
    tests: [],
    ...(options.total === undefined ? {} : { total: options.total }),
    free: false,
    finishing: false,
    hold: options.gate.hold,
  };
  /** Files a step has named: the only ones `/source` serves. */
  const known = new Set<string>();
  const clients = new Set<http.ServerResponse>();
  let testTitle = '';
  const testTitles = new Map<string, string>();

  const snapshot = (): string => JSON.stringify(state);
  const broadcast = (): void => {
    const data = `data: ${snapshot()}\n\n`;
    for (const client of clients) client.write(data);
  };

  const server = http.createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const prefix = `/${token}/`;

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (host === undefined || !origins.has(`http://${host}`) || (origin !== undefined && !origins.has(origin))) {
      response.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const route = url.pathname.slice(prefix.length);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

    if (request.method === 'GET' && route === '') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      response.end(INSPECTOR_PAGE);
      return;
    }
    if (request.method === 'GET' && route === 'events') {
      response.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      response.write(`data: ${snapshot()}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'GET' && route === 'source') {
      const file = url.searchParams.get('file') ?? '';
      const resolved = path.resolve(options.projectRoot, file);
      const inside = resolved.startsWith(path.resolve(options.projectRoot) + path.sep);
      if (!known.has(file) || !inside) {
        response.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const text = await readFile(resolved, 'utf8');
      if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) {
        response.writeHead(413, { ...headers, 'content-type': 'text/plain' }).end('too large');
        return;
      }
      response.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end(text);
      return;
    }
    if (request.method === 'POST' && (route === 'press' || route === 'hold')) {
      // A form on another site can send text/plain without a preflight; only a script of this page sends JSON.
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        response.writeHead(415, headers).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
          response.writeHead(413, headers).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        response.writeHead(400, headers).end();
        return;
      }
      if (route === 'hold') {
        const { setup, retries } = body;
        if ((setup !== undefined && typeof setup !== 'boolean') || (retries !== undefined && typeof retries !== 'boolean') || (setup === undefined && retries === undefined)) {
          response.writeHead(400, headers).end();
          return;
        }
        const hold = options.gate.setHold({ ...(setup === undefined ? {} : { setup }), ...(retries === undefined ? {} : { retries }) });
        response.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ hold }));
        return;
      }
      const action = body['action'];
      if (typeof action !== 'string' || !ACTIONS.has(action)) {
        response.writeHead(400, headers).end();
        return;
      }
      const pressed = options.gate.press(action as StepAction);
      response.writeHead(pressed ? 200 : 409, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ pressed }));
      return;
    }
    response.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found');
  }

  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    onGateEvent(event) {
      switch (event.kind) {
        case 'arrive': {
          const { file, line } = splitSource(event.request.source);
          if (file !== undefined) known.add(file);
          const key = `${event.targetName}|${event.request.testId}|${event.request.agent}|${String(event.request.repeat)}`;
          state.steps.push({
            n: state.steps.length + 1,
            testId: event.request.testId,
            testKey: key,
            attempt: event.request.attempt,
            setup: event.request.setup,
            ...(event.auto === undefined ? {} : { auto: event.auto }),
            test: testTitles.get(event.request.testId) ?? testTitle,
            target: event.targetName,
            api: event.request.api,
            label: event.request.label,
            ...(file === undefined ? {} : { file }),
            ...(line === undefined ? {} : { line }),
            status: event.waits ? 'waiting' : 'running',
          });
          state.current = state.steps.length - 1;
          state.phase = event.waits ? 'paused' : 'running';
          // A step that waits is the first one past the test the person chose to finish.
          if (event.waits) state.finishing = false;
          break;
        }
        case 'release': {
          const step = state.current === undefined ? undefined : state.steps[state.current];
          if (step !== undefined && step.status === 'waiting') step.status = 'running';
          state.phase = 'running';
          break;
        }
        case 'test':
          state.finishing = true;
          break;
        case 'hold':
          state.hold = event.hold;
          break;
        case 'free':
          state.free = true;
          break;
        case 'stop':
          state.phase = 'stopped';
          break;
      }
      broadcast();
    },
    onRunEvent(event) {
      if (event.type === 'plan') {
        state.total = event.files.reduce((sum, file) => sum + file.tests, 0);
      } else if (event.type === 'test-started') {
        testTitle = event.title;
        testTitles.set(event.testId, event.title);
        const key = `${event.target}|${event.testId}|${event.agent}|${String(event.repeat)}`;
        if (!state.tests.some((test) => test.key === key)) state.tests.push({ key, target: event.target, title: event.title, file: event.file, status: 'running' });
      } else if (event.type === 'test-finished') {
        const { result } = event;
        const key = `${result.target.name}|${result.test.id}|${result.agent}|${String(result.repeat)}`;
        const test = state.tests.find((candidate) => candidate.key === key);
        if (test !== undefined) test.status = result.status;
      } else if (event.type === 'step' && event.progress.phase === 'end') {
        const progress = event.progress;
        for (let index = state.steps.length - 1; index >= 0; index -= 1) {
          const step = state.steps[index]!;
          if (step.testId === event.testId && step.api === progress.api && (step.status === 'running' || step.status === 'waiting')) {
            step.status = progress.status === 'passed' ? 'passed' : progress.status;
            step.durationMs = progress.durationMs;
            if (progress.error !== undefined) step.error = progress.error.message;
            break;
          }
        }
      } else if (event.type === 'run-finished') {
        if (state.phase !== 'stopped') state.phase = 'finished';
      } else {
        return;
      }
      broadcast();
    },
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
