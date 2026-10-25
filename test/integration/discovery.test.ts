import { strict as assert } from 'node:assert';
import * as net from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { scanHosts } from '../../src/lib/Discovery';
import type { Cleanups } from './mockCamera';
import { startMock } from './mockCamera';

const cleanups: Cleanups = [];
afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()!();
    }
});

const req = (port: number, password = 'secret') => ({ subnet: '', https: false, port, username: 'admin', password });

describe('scanHosts (mock camera)', () => {
    it('finds an ISAPI camera and reads its model', async () => {
        const mock = await startMock({}, cleanups);
        const r = await scanHosts(['127.0.0.1'], req(mock.port));
        assert.equal(r.scanned, 1);
        assert.deepEqual(r.found, [
            { host: '127.0.0.1', status: 'ok', model: 'DS-MOCK-1', deviceName: 'Mock', deviceType: undefined, firmware: 'V9.9.9' },
        ]);
        assert.equal(mock.streams, 0, 'discovery never opens the event stream');
    });

    it('reports a rejected login with exactly one attempt', async () => {
        const mock = await startMock({}, cleanups);
        const r = await scanHosts(['127.0.0.1'], req(mock.port, 'wrong'));
        assert.deepEqual(r.found, [{ host: '127.0.0.1', status: 'auth' }]);
        assert.equal(mock.authedRequests, 1);
    });

    it('ignores HTTP servers without ISAPI', async () => {
        const mock = await startMock({ mode: '404' }, cleanups);
        const r = await scanHosts(['127.0.0.1'], req(mock.port));
        assert.deepEqual(r.found, []);
    });

    it('skips closed ports quickly', async () => {
        const srv = net.createServer();
        await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
        const port = (srv.address() as net.AddressInfo).port;
        await new Promise<void>(resolve => srv.close(() => resolve()));
        const started = Date.now();
        const r = await scanHosts(['127.0.0.1'], req(port), { probeTimeoutMs: 300 });
        assert.deepEqual(r.found, []);
        assert.ok(Date.now() - started < 2000);
    });
});
