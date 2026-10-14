/** The `--inspect` control server: its routes, what it refuses, and the state it streams. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '../../src/run/events.ts';
import { startInspector, type Inspector } from '../../src/run/inspector.ts';
import type { StepGateRequest } from '../../src/run/worker/protocol.ts';

const request = (index: number, source: string | undefined = 'tests/a.e2e.ts:5', extra: Partial<StepGateRequest> = {}): StepGateRequest => ({
  testId: 't1',
  agent: 'default',
  repeat: 0,
  index,
  attempt: 0,
  setup: false,
  api: 'app.open',
  label: '/todos',
  ...(source === undefined ? {} : { source }),
  ...extra,
});

interface Reply {
  readonly status: number;
  readonly body: string;
}

/** One request with full control of the headers, which `fetch` does not give for Host. */
function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; path?: string } = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.hostname, port: target.port, path: options.path ?? target.pathname + target.search, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Reads the state messages of the event stream as they arrive. */
function listen(url: string): { next: () => Promise<Record<string, unknown>>; close: () => void } {
  const queue: Record<string, unknown>[] = [];
  let waiting: ((state: Record<string, unknown>) => void) | undefined;
  let buffer = '';
  const req = http.get(url, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const message = JSON.parse(buffer.slice('data: '.length, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 2);
        if (waiting !== undefined) {
          const resolve = waiting;
          waiting = undefined;
          resolve(message);
        } else queue.push(message);
      }
    });
  });
  req.on('error', () => undefined);
  return {
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => (waiting = resolve))),
    close: () => req.destroy(),
  };
}

/** Reads states until one satisfies `done`: a run event may broadcast on its way to the one a test wants. */
async function until(events: { next: () => Promise<Record<string, unknown>> }, done: (state: Record<string, any>) => boolean): Promise<Record<string, unknown>> {
  for (;;) {
    const state = await events.next();
    if (done(state)) return state;
  }
}

describe('startInspector', () => {
  let root: string;
  let inspector: Inspector;
  const press = vi.fn<(action: string) => boolean>();
  const setHold = vi.fn<(change: { setup?: boolean; retries?: boolean }) => { setup: boolean; retries: boolean }>();

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-inspector-test-'));
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts'), "test('x', async () => {\n  await app.open();\n});\n");
    writeFileSync(path.join(path.dirname(root), 'outside-inspector.ts'), 'secret\n');
    press.mockReset().mockReturnValue(true);
    setHold.mockReset().mockImplementation((change) => ({ setup: change.setup ?? false, retries: change.retries ?? false }));
    inspector = await startInspector({ projectRoot: root, gate: { press, setHold, hold: { setup: false, retries: false } } });
  });

  afterEach(async () => {
    await inspector.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(path.join(path.dirname(root), 'outside-inspector.ts'), { force: true });
  });

  it('serves its page at a loopback address with a token in the path', async () => {
    expect(inspector.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/u);
    const reply = await send(inspector.url);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('id="next"');
    expect(reply.body).toContain('id="rest"');
    expect(reply.body).toContain('id="stop"');
  });

  it('refuses a path without the token, a foreign Host, and a foreign Origin', async () => {
    const base = new URL(inspector.url);
    expect((await send(inspector.url, { path: '/' })).status).toBe(404);
    expect((await send(inspector.url, { path: `/${'0'.repeat(32)}/` })).status).toBe(404);
    expect((await send(inspector.url, { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await send(inspector.url, { headers: { host: `evil.example:${base.port}` } })).status).toBe(403);
    expect((await send(inspector.url, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await send(inspector.url, { headers: { host: `localhost:${base.port}`, origin: `http://localhost:${base.port}` } })).status).toBe(200);
  });

  describe('press', () => {
    const post = (body: string, contentType = 'application/json') =>
      send(`${inspector.url}press`, { method: 'POST', headers: { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) }, body });

    it.each([['next'], ['test'], ['rest'], ['stop']])('passes %s to the gate', async (action) => {
      const reply = await post(JSON.stringify({ action }));
      expect(reply).toEqual({ status: 200, body: '{"pressed":true}' });
      expect(press).toHaveBeenCalledWith(action);
    });

    it('answers 409 when no step is held', async () => {
      press.mockReturnValue(false);
      expect((await post('{"action":"next"}')).status).toBe(409);
    });

    it('refuses anything that is not JSON from this page, an unknown action, a bad body, and a large one', async () => {
      expect((await post('{"action":"next"}', 'text/plain')).status).toBe(415);
      expect((await post('{"action":"next"}', 'application/x-www-form-urlencoded')).status).toBe(415);
      expect((await post('{"action":"run"}')).status).toBe(400);
      expect((await post('{"action":1}')).status).toBe(400);
      expect((await post('not json')).status).toBe(400);
      expect((await post(JSON.stringify({ action: 'next', pad: 'x'.repeat(2000) }))).status).toBe(413);
      expect(press).not.toHaveBeenCalled();
    });

    it('changes what is held through /hold, and refuses a bad request', async () => {
      const hold = (body: string, contentType = 'application/json') =>
        send(`${inspector.url}hold`, { method: 'POST', headers: { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) }, body });
      expect(await hold('{"setup":true}')).toEqual({ status: 200, body: '{"hold":{"setup":true,"retries":false}}' });
      expect(setHold).toHaveBeenLastCalledWith({ setup: true });
      expect((await hold('{"retries":true,"setup":false}')).status).toBe(200);
      expect(setHold).toHaveBeenLastCalledWith({ setup: false, retries: true });
      expect((await hold('{}')).status).toBe(400);
      expect((await hold('{"setup":"yes"}')).status).toBe(400);
      expect((await hold('[]')).status).toBe(400);
      expect((await hold('{"setup":true}', 'text/plain')).status).toBe(415);
      expect(setHold).toHaveBeenCalledTimes(2);
    });

    it('refuses a press from a foreign Origin', async () => {
      const reply = await send(`${inspector.url}press`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
        body: '{"action":"stop"}',
      });
      expect(reply.status).toBe(403);
      expect(press).not.toHaveBeenCalled();
    });
  });

  describe('source', () => {
    const source = (file: string) => send(`${inspector.url}source?file=${encodeURIComponent(file)}`);

    it('serves a file a step names, and only that', async () => {
      expect((await source('tests/a.e2e.ts')).status).toBe(404);
      inspector.onGateEvent({ kind: 'arrive', request: request(0), targetName: 'web', waits: false });
      expect(await source('tests/a.e2e.ts')).toEqual({ status: 200, body: "test('x', async () => {\n  await app.open();\n});\n" });
      expect((await source('tests/other.e2e.ts')).status).toBe(404);
      expect((await source('package.json')).status).toBe(404);
    });

    it('refuses a named file that is outside the project', async () => {
      inspector.onGateEvent({ kind: 'arrive', request: request(0, '../outside-inspector.ts:1'), targetName: 'web', waits: false });
      expect((await source('../outside-inspector.ts')).status).toBe(404);
    });
  });

  describe('state', () => {
    it('starts with no steps, then follows the gate and the run', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        expect(await events.next()).toEqual({ phase: 'starting', steps: [], tests: [], free: false, finishing: false, hold: { setup: false, retries: false } });

        inspector.onRunEvent({ type: 'test-started', testId: 't1', title: 'adds a todo', target: 'web' } as unknown as RunEvent);
        inspector.onGateEvent({ kind: 'arrive', request: request(0), targetName: 'web', waits: false });
        expect(await until(events, (state) => state['steps'].length === 1)).toMatchObject({
          phase: 'running',
          current: 0,
          steps: [{ n: 1, test: 'adds a todo', api: 'app.open', label: '/todos', file: 'tests/a.e2e.ts', line: 5, status: 'running' }],
        });

        inspector.onRunEvent({ type: 'step', testId: 't1', agent: 'default', repeat: 0, target: 'web', progress: { phase: 'end', api: 'app.open', status: 'passed', durationMs: 12 } } as unknown as RunEvent);
        expect(await events.next()).toMatchObject({ steps: [{ status: 'passed', durationMs: 12 }] });

        inspector.onGateEvent({ kind: 'arrive', request: request(1, 'tests/a.e2e.ts:6', { api: 'expect.toHaveURL' }), targetName: 'web', waits: true });
        expect(await events.next()).toMatchObject({ phase: 'paused', current: 1, steps: [{ status: 'passed' }, { n: 2, status: 'waiting', line: 6 }] });

        inspector.onGateEvent({ kind: 'release', request: request(1) });
        expect(await events.next()).toMatchObject({ phase: 'running', steps: [{}, { status: 'running' }] });

        inspector.onGateEvent({ kind: 'free' });
        expect(await events.next()).toMatchObject({ free: true });

        inspector.onRunEvent({ type: 'step', testId: 't1', agent: 'default', repeat: 0, target: 'web', progress: { phase: 'end', api: 'expect.toHaveURL', status: 'failed', durationMs: 3, error: { message: 'wrong url' } } } as unknown as RunEvent);
        expect(await events.next()).toMatchObject({ steps: [{}, { status: 'failed', error: 'wrong url' }] });

        inspector.onRunEvent({ type: 'run-finished' } as unknown as RunEvent);
        expect(await events.next()).toMatchObject({ phase: 'finished' });
      } finally {
        events.close();
      }
    });

    it('stays stopped once stopped, through the run finishing', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        await events.next();
        inspector.onGateEvent({ kind: 'stop' });
        expect(await events.next()).toMatchObject({ phase: 'stopped' });
        inspector.onRunEvent({ type: 'run-finished' } as unknown as RunEvent);
        expect(await events.next()).toMatchObject({ phase: 'stopped' });
      } finally {
        events.close();
      }
    });

    it('ignores run events that say nothing the page shows', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        await events.next();
        inspector.onRunEvent({ type: 'notice', target: 'web', message: 'x' } as unknown as RunEvent);
        inspector.onGateEvent({ kind: 'stop' });
        expect(await events.next()).toMatchObject({ phase: 'stopped' });
      } finally {
        events.close();
      }
    });
  });

  describe('overview', () => {
    const started = (id: string, title: string, file = 'tests/a.e2e.ts', target = 'web') =>
      ({ type: 'test-started', testId: id, agent: 'default', repeat: 0, title, file, target }) as unknown as RunEvent;
    const finished = (id: string, status: string, target = 'web') =>
      ({ type: 'test-finished', result: { test: { id }, target: { name: target }, agent: 'default', repeat: 0, status } }) as unknown as RunEvent;

    it('counts the run\'s tests, lists each as it starts, and marks it when its result arrives', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        await events.next();
        inspector.onRunEvent({ type: 'plan', total: 9, files: [{ file: 'a', target: 'web', tests: 1 }, { file: 'b', target: 'web', tests: 2 }] } as unknown as RunEvent);
        expect(await events.next()).toMatchObject({ total: 3, tests: [] });

        inspector.onRunEvent(started('t1', 'adds a todo'));
        inspector.onRunEvent(started('t1', 'adds a todo'));
        inspector.onRunEvent(finished('t1', 'passed'));
        expect(await until(events, (state) => state['tests'].length === 1 && state['tests'][0].status === 'passed')).toMatchObject({
          tests: [{ key: 'web|t1|default|0', title: 'adds a todo', file: 'tests/a.e2e.ts', status: 'passed' }],
        });

        inspector.onRunEvent(started('t2', 'removes a todo'));
        inspector.onRunEvent(finished('t2', 'failed'));
        expect(await until(events, (state) => state['tests'].length === 2 && state['tests'][1].status === 'failed')).toMatchObject({
          tests: [{ status: 'passed' }, { title: 'removes a todo', status: 'failed' }],
        });
      } finally {
        events.close();
      }
    });

    it('keeps the same test on two targets apart: two tests, two groups of steps', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        await events.next();
        inspector.onRunEvent(started('t1', 'adds a todo', 'tests/a.e2e.ts', 'chromium'));
        inspector.onGateEvent({ kind: 'arrive', request: request(0), targetName: 'chromium', waits: false });
        inspector.onRunEvent(finished('t1', 'passed', 'chromium'));
        inspector.onRunEvent(started('t1', 'adds a todo', 'tests/a.e2e.ts', 'firefox'));
        inspector.onGateEvent({ kind: 'arrive', request: request(0), targetName: 'firefox', waits: true });
        const state = await until(events, (current) => current['steps'].length === 2 && current['tests'].length === 2);
        expect(state).toMatchObject({
          tests: [
            { key: 'chromium|t1|default|0', target: 'chromium', status: 'passed' },
            { key: 'firefox|t1|default|0', target: 'firefox', status: 'running' },
          ],
          steps: [{ testKey: 'chromium|t1|default|0', target: 'chromium' }, { testKey: 'firefox|t1|default|0', target: 'firefox' }],
        });
      } finally {
        events.close();
      }
    });

    it('tags each step with its test run, attempt, and why it went through without waiting', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        await events.next();
        inspector.onGateEvent({ kind: 'arrive', request: request(0, 'tests/a.e2e.ts:5', { attempt: 1, setup: true }), targetName: 'web', waits: false, auto: 'retry' });
        expect(await events.next()).toMatchObject({ steps: [{ testKey: 'web|t1|default|0', attempt: 1, setup: true, auto: 'retry', status: 'running' }] });
      } finally {
        events.close();
      }
    });

    it('says a test is being finished until a step waits again, and follows the hold toggles', async () => {
      const events = listen(`${inspector.url}events`);
      try {
        await events.next();
        inspector.onGateEvent({ kind: 'test' });
        expect(await events.next()).toMatchObject({ finishing: true });
        inspector.onGateEvent({ kind: 'arrive', request: request(3), targetName: 'web', waits: false, auto: 'test' });
        expect(await events.next()).toMatchObject({ finishing: true });
        inspector.onGateEvent({ kind: 'arrive', request: request(0, undefined, { testId: 't2' }), targetName: 'web', waits: true });
        expect(await events.next()).toMatchObject({ finishing: false, phase: 'paused' });
        inspector.onGateEvent({ kind: 'hold', hold: { setup: true, retries: false } });
        expect(await events.next()).toMatchObject({ hold: { setup: true, retries: false } });
      } finally {
        events.close();
      }
    });
  });

  it('starts with the run\'s total, which was announced before the server existed', async () => {
    const withTotal = await startInspector({ projectRoot: root, gate: { press, setHold, hold: { setup: false, retries: false } }, total: 7 });
    const events = listen(`${withTotal.url}events`);
    try {
      expect(await events.next()).toMatchObject({ total: 7, tests: [] });
    } finally {
      events.close();
      await withTotal.close();
    }
  });

  it('stops serving when closed, ending open event streams', async () => {
    const events = listen(`${inspector.url}events`);
    await events.next();
    await inspector.close();
    await expect(send(inspector.url)).rejects.toThrow();
    events.close();
  });
});
