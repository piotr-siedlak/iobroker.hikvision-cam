import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { testCamera } from '../../src/lib/ConnectionTest';
import type { Cleanups } from './mockCamera';
import { startMock } from './mockCamera';

const cleanups: Cleanups = [];
afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()!();
    }
});

// Values arrive from the admin row as strings (jsonData placeholders).
const row = (port: number, over: Record<string, unknown> = {}) => ({
    name: 'Gate',
    host: '127.0.0.1',
    protocol: 'http',
    port: String(port),
    username: 'admin',
    password: 'secret',
    authMode: 'digest',
    verifyTls: 'true',
    mode: 'stream',
    ...over,
});

describe('Test connection (admin button)', () => {
    it('reports model, firmware and stream access', async () => {
        const mock = await startMock({}, cleanups);
        const r = await testCamera(row(mock.port));
        assert.equal(r.ok, true, r.message);
        assert.match(r.message, /DS-MOCK-1, firmware V9\.9\.9/);
        assert.match(r.message, /alertStream/);
        assert.equal(mock.streams, 1);
    });

    it('wrong password: fails after one rejected login and never touches the stream', async () => {
        const mock = await startMock({}, cleanups);
        const r = await testCamera(row(mock.port, { password: 'wrong' }));
        assert.equal(r.ok, false);
        assert.match(r.message, /Authentication failed/);
        assert.equal(mock.authedRequests, 1);
        assert.equal(mock.streams, 0);
        assert.doesNotMatch(r.message, /wrong/);
    });

    it('device info forbidden is not fatal; the stream is still checked', async () => {
        const mock = await startMock({ deviceInfo: '403' }, cleanups);
        const r = await testCamera(row(mock.port));
        assert.equal(r.ok, true, r.message);
        assert.match(r.message, /not permitted/);
    });

    it('reports an unsupported alertStream', async () => {
        const mock = await startMock({ mode: '404' }, cleanups);
        const r = await testCamera(row(mock.port));
        assert.equal(r.ok, false);
        assert.match(r.message, /not supported/);
    });

    it('reports an unreachable camera', async () => {
        const mock = await startMock({ mode: 'silent' }, cleanups);
        const r = await testCamera(row(mock.port), { timeoutMs: 200 });
        assert.equal(r.ok, false);
        assert.match(r.message, /No response/);
    });

    it('rejects invalid settings without any network access', async () => {
        assert.match((await testCamera(row(1, { host: 'http://x' }))).message, /invalid characters/);
        assert.equal((await testCamera(row(1, { username: '' }))).ok, false);
    });

    it('push mode without credentials only validates settings', async () => {
        const r = await testCamera(row(1, { mode: 'push', username: '' }));
        assert.equal(r.ok, true);
        assert.match(r.message, /Push mode/);
    });
});
