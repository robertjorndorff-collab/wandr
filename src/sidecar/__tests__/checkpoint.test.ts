import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Checkpoint } from '../checkpoint.js';
import type { SlackTransport } from '../slack-transport.js';

function makeFakeTransport(): SlackTransport {
  return {
    postCheckpoint: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackTransport;
}

describe('Checkpoint state machine', () => {
  let cp: Checkpoint;
  let transport: SlackTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = makeFakeTransport();
    cp = new Checkpoint('test-agent', transport, '/tmp/test.log');
  });

  afterEach(() => {
    cp.stop();
    vi.useRealTimers();
  });

  it('starts in idle state', () => {
    expect(cp.getState()).toBe('idle');
    expect(cp.getCurrentPrompt()).toBeNull();
  });

  it('transitions idle → working when a task is dispatched', () => {
    cp.onTaskDispatched('do the thing');
    expect(cp.getState()).toBe('working');
    expect(cp.getCurrentPrompt()).toBe('do the thing');
  });

  it('records activity while working', () => {
    cp.onTaskDispatched('task');
    cp.onActivity('some output line');
    expect(cp.getState()).toBe('working');
  });

  it('transitions working → idle (task complete) after idle timeout with no activity', () => {
    cp.start();
    cp.onTaskDispatched('task');
    expect(cp.getState()).toBe('working');
    // No activity for >30s and tick fires
    vi.advanceTimersByTime(35_000);
    expect(cp.getState()).toBe('idle');
    expect(cp.getCurrentPrompt()).toBeNull();
  });

  it('emits task-complete event on working → idle', () => {
    const spy = vi.fn();
    cp.on('task-complete', spy);
    cp.start();
    cp.onTaskDispatched('task');
    vi.advanceTimersByTime(35_000);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('transitions working → stalled when activity is older than stall timeout', () => {
    cp.start();
    cp.onTaskDispatched('long task');
    // Force lastActivityAt into the distant past so the next tick sees a stall.
    // (In real life the idle timeout fires first on a 5s tick, so the only way
    //  to reach 'stalled' is for activity to age out between ticks.)
    (cp as unknown as { lastActivityAt: number }).lastActivityAt =
      Date.now() - 6 * 60 * 1000;
    vi.advanceTimersByTime(5_000); // one tick
    expect(cp.getState()).toBe('stalled');
  });

  it('recovers from stalled → working when activity resumes', () => {
    cp.start();
    cp.onTaskDispatched('task');
    (cp as unknown as { lastActivityAt: number }).lastActivityAt =
      Date.now() - 6 * 60 * 1000;
    vi.advanceTimersByTime(5_000);
    expect(cp.getState()).toBe('stalled');
    cp.onActivity('back alive');
    expect(cp.getState()).toBe('working');
  });

  it('onTaskDispatched resets currentPrompt to the new task', () => {
    cp.onTaskDispatched('first');
    cp.onTaskDispatched('second');
    expect(cp.getCurrentPrompt()).toBe('second');
    expect(cp.getState()).toBe('working');
  });

  it('does not transition out of idle on activity without a dispatched task', () => {
    cp.onActivity('stray output');
    expect(cp.getState()).toBe('idle');
  });
});
