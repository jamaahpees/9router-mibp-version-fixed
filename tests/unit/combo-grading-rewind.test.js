import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleComboChat, resetComboRotation } from '../../open-sse/services/combo.js';

const models = ['test/a', 'test/b', 'test/c'];
const log = { info: vi.fn(), warn: vi.fn() };
const ok = () => new Response('OK');
const fail = () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
const mkAvail = (map, seen) => async (m) => { seen.push(m); return (m in map) ? { availableCount: map[m], totalCount: 1, retryAfter: null } : { availableCount: 1, totalCount: 1, retryAfter: null }; };
const options = (call, availMap, extra = {}) => ({ body: {}, models, comboName: 'rewind', comboStrategy: 'fallback-grading', handleSingleModel: call, log, checkModelAvailability: mkAvail(availMap, extra.seen || []), ...extra });

async function advanceToGrade(call, grade, failed) {
  for (let g = 0; g < grade; g++) { failed.add(models[g]); await handleComboChat(options(call, {})); }
}

describe('fallback grading rewind monitor', () => {
  beforeEach(() => { resetComboRotation(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('rewinds to grade 1 when its accounts recover', async () => {
    const failed = new Set();
    const call = vi.fn(async (_, m) => (failed.has(m) ? fail() : ok()));
    await handleComboChat(options(call, {}));
    failed.add(models[0]);
    await handleComboChat(options(call, {}));
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
    failed.delete(models[0]);
    vi.advanceTimersByTime(7 * 86400000);
    const seen = [];
    await handleComboChat(options(call, { [models[0]]: 1 }, { seen }));
    expect(seen).toContain(models[0]);
    expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
  });

  it('stays on current grade while grade 1 is still blocked at account level', async () => {
    const failed = new Set();
    const call = vi.fn(async (_, m) => (failed.has(m) ? fail() : ok()));
    await advanceToGrade(call, 1, failed);
    vi.advanceTimersByTime(7 * 86400000);
    await handleComboChat(options(call, { [models[0]]: 0 }));
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
  });

  it('rewinds to grade 2 when grade 1 is blocked but grade 2 recovered', async () => {
    const failed = new Set();
    const call = vi.fn(async (_, m) => (failed.has(m) ? fail() : ok()));
    await advanceToGrade(call, 2, failed);
    expect(call.mock.calls.at(-1)[1]).toBe(models[2]);
    failed.delete(models[1]);
    vi.advanceTimersByTime(7 * 86400000);
    await handleComboChat(options(call, { [models[0]]: 0, [models[1]]: 1 }));
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
  });

  it('does not probe a grade whose model cooldown is still active', async () => {
    const failed = new Set();
    const call = vi.fn(async (_, m) => (failed.has(m) ? fail() : ok()));
    await advanceToGrade(call, 1, failed);
    const seen = [];
    await handleComboChat(options(call, { [models[0]]: 1 }, { seen }));
    expect(seen).not.toContain(models[0]);
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
  });

  it('aborted signal during rewind check throws without dispatching', async () => {
    const failed = new Set();
    const call = vi.fn(async (_, m) => (failed.has(m) ? fail() : ok()));
    await advanceToGrade(call, 1, failed);
    vi.advanceTimersByTime(7 * 86400000);
    const before = call.mock.calls.length;
    await expect(handleComboChat(options(call, { [models[0]]: 1 }, { signal: { aborted: true } }))).rejects.toThrow('Request aborted');
    expect(call.mock.calls.length).toBe(before);
  });
});
