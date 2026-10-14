/**
 * The inspector of a run stepped through with `--inspect`, shown in a window of
 * its own beside the browser under test: the page opens in an app-mode
 * Chromium window on the left half of the screen, and the test browser is
 * launched into the right half. The screen is measured from that window, so
 * no platform call is needed to find its size.
 *
 * A Wayland session ignores the position a program asks for, so there Chromium
 * is started through XWayland (`--ozone-platform=x11`), where it is honoured.
 *
 * The window is launched through Playwright, which talks to it over a pipe:
 * it opens no network port, and it ends with the worker that opened it even
 * when the worker is killed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';

export interface InspectorWindow {
  /** Launch flags that put the browser under test on the right half of the screen. */
  readonly browserArgs: readonly string[];
  /** Closes the window; idempotent, and best-effort. */
  close(): Promise<void>;
}

export interface InspectorWindowContext {
  /** Reports one line of progress. */
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
}

/** How long the window gets to come up and answer before the page is left to the person to open. */
const WINDOW_TIMEOUT_MS = 15_000;

/** Flags that make Chromium use XWayland on a Wayland desktop, where window positions are honoured; none elsewhere. */
export function displayArgs(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string[] {
  const wayland = env['WAYLAND_DISPLAY'] !== undefined && env['WAYLAND_DISPLAY'] !== '';
  const x11 = env['DISPLAY'] !== undefined && env['DISPLAY'] !== '';
  return platform === 'linux' && wayland && x11 ? ['--ozone-platform=x11'] : [];
}

/** The screen's usable area, as the browser reports it. */
export interface ScreenArea {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Splits `screen` into a left half for the control window and a right half for the browser. */
export function halves(screen: ScreenArea): { readonly control: ScreenArea; readonly browser: ScreenArea } {
  const width = Math.floor(screen.width / 2);
  return {
    control: { left: screen.left, top: screen.top, width, height: screen.height },
    browser: { left: screen.left + width, top: screen.top, width: screen.width - width, height: screen.height },
  };
}

/** Browser launch flags that open its first window on `area`. */
export function windowArgs(area: ScreenArea): string[] {
  return [`--window-position=${area.left},${area.top}`, `--window-size=${area.width},${area.height}`];
}

/**
 * Opens the inspector in a window on the left half of the screen, or
 * resolves undefined, with a line saying why, when it cannot: no display, no
 * Chromium, a window that never answers. The run goes on either way; the page
 * is at its address for the person to open.
 */
export async function openInspectorWindow(url: string, context: InspectorWindowContext): Promise<InspectorWindow | undefined> {
  const profile = mkdtempSync(path.join(tmpdir(), 'e2e-inspector-'));
  const display = displayArgs(process.env);
  let appWindow: BrowserContext | undefined;
  const close = async (): Promise<void> => {
    const open = appWindow;
    appWindow = undefined;
    await open?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    appWindow = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: null,
      timeout: WINDOW_TIMEOUT_MS,
      // The runner owns Ctrl-C and its escalation; a window must not take the signal first.
      handleSIGINT: false,
      handleSIGTERM: false,
      args: [`--app=${url}`, '--window-size=800,800', ...display],
    });
    if (context.signal.aborted) throw new Error('cancelled');
    const page = appWindow.pages()[0] ?? (await appWindow.waitForEvent('page', { timeout: WINDOW_TIMEOUT_MS }));
    const area = await page.evaluate(() => {
      const s = window.screen as Screen & { availLeft?: number; availTop?: number };
      return { left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight };
    });
    const { control, browser: right } = halves(area);
    const session = await appWindow.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: control.left, top: control.top, width: control.width, height: control.height, windowState: 'normal' },
    });
    return { browserArgs: [...windowArgs(right), ...display], close };
  } catch (cause) {
    context.log(`could not open the inspector in a window (${cause instanceof Error ? cause.message : String(cause)}); open it yourself at ${url}`);
    await close();
    return undefined;
  }
}
