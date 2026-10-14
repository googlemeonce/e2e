/** The control window's placement: the Wayland flag, the two halves of the screen, and the launch flags. */

import { describe, expect, it } from 'vitest';
import { displayArgs, halves, windowArgs } from '../../src/inspector-window.ts';

describe('displayArgs', () => {
  it('starts Chromium through XWayland on a Linux Wayland desktop that has an X display', () => {
    expect(displayArgs({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'linux')).toEqual(['--ozone-platform=x11']);
  });

  it('adds nothing without Wayland, without an X display, or off Linux', () => {
    expect(displayArgs({ DISPLAY: ':0' }, 'linux')).toEqual([]);
    expect(displayArgs({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toEqual([]);
    expect(displayArgs({ WAYLAND_DISPLAY: '', DISPLAY: ':0' }, 'linux')).toEqual([]);
    expect(displayArgs({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: '' }, 'linux')).toEqual([]);
    expect(displayArgs({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'darwin')).toEqual([]);
    expect(displayArgs({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'win32')).toEqual([]);
  });
});

describe('halves', () => {
  it('gives the control window the left half and the browser the right half of the usable screen', () => {
    expect(halves({ left: 0, top: 29, width: 1920, height: 1051 })).toEqual({
      control: { left: 0, top: 29, width: 960, height: 1051 },
      browser: { left: 960, top: 29, width: 960, height: 1051 },
    });
  });

  it('keeps an odd width whole, the browser taking the extra pixel', () => {
    const { control, browser } = halves({ left: 10, top: 0, width: 1001, height: 700 });
    expect(control.width + browser.width).toBe(1001);
    expect(browser.left).toBe(control.left + control.width);
    expect(browser.left).toBe(510);
  });

  it('starts at the usable area, not the screen corner, when a panel takes the edge', () => {
    expect(halves({ left: 64, top: 0, width: 1856, height: 1080 }).browser.left).toBe(64 + 928);
  });
});

describe('windowArgs', () => {
  it('names the position and size of the area', () => {
    expect(windowArgs({ left: 960, top: 29, width: 960, height: 1051 })).toEqual(['--window-position=960,29', '--window-size=960,1051']);
  });
});
