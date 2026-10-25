import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { CameraClient } from '../../src/lib/CameraClient';
import { ConnectionManager } from '../../src/lib/ConnectionManager';
import { RetryPolicy } from '../../src/lib/RetryPolicy';
import type { HikvisionEvent } from '../../src/lib/types';
import { alertXml, heartbeatXml, multipartPart } from '../fixtures';

// Mock ISAPI camera: HTTP Digest + multipart alertStream. All data is synthetic.

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
const REALM = 'mock-camera';
const NONCE = 'a1b2c3d4e5f6';

interface MockOptions {
    user?: string;
    pass?: string;
    mode?: 'stream' | '403' | '404' | 'silent';
    onStream?: (res: http.ServerResponse, connection: number) => void;
}

interface Mock {
    port: number;
    requests: number;
    authedRequests: number;
    streams: number;
    close(): Promise<void>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()!();
    }
});

async function startMock(o: MockOptions = {}): Promise<Mock> {
    const user = o.user ?? 'admin';
    const pass = o.pass ?? 'secret';
    const state = { requests: 0, authedRequests: 0, streams: 0 };
    const server = http.createServer((req, res) => {
        state.requests++;
        if (o.mode === 'silent') {
            return; // never answer
        }
        if (o.mode === '404') {
            res.writeHead(404).end();
            return;
        }
        if (o.mode === '403') {
            res.writeHead(403).end();
            return;
        }
        const auth = req.headers.authorization;
        let ok = false;
        if (auth?.startsWith('Digest ')) {
            state.authedRequests++;
            const p: Record<string, string> = {};
            for (const m of auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
                p[m[1]] = m[2] ?? m[3];
            }
            const ha1 = md5(`${p.username}:${REALM}:${pass}`);
            const ha2 = md5(`GET:${req.url}`);
            const expected = md5(`${ha1}:${NONCE}:${p.nc}:${p.cnonce}:auth:${ha2}`);
            ok = p.username === user && p.response === expected && p.nonce === NONCE;
        }
        if (!ok) {
            res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", qop="auth", nonce="${NONCE}"` }).end();
            return;
        }
        assert.equal(req.url, '/ISAPI/Event/notification/alertStream');
        const connection = ++state.streams;
        res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=boundary', Connection: 'keep-alive' });
        o.onStream?.(res, connection);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const mock = {
        port: (server.address() as AddressInfo).port,
        get requests() {
            return state.requests;
        },
        get authedRequests() {
            return state.authedRequests;
        },
        get streams() {
            return state.streams;
        },
        close: () =>
            new Promise<void>(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    cleanups.push(() => mock.close());
    return mock;
}

interface ManagerSetup {
    username?: string;
    password?: string;
    idleMs?: number;
    connectTimeoutMs?: number;
    authRetryMs?: number;
    maxAuthFailures?: number;
    maxPartBytes?: number;
}

function createManager(port: number, s: ManagerSetup = {}) {
    const events: HikvisionEvent[] = [];
    const states: string[] = [];
    const parseErrors: string[] = [];
    const log = { connected: 0, disconnected: 0, live: 0 };
    const client = new CameraClient({
        host: '127.0.0.1',
        port,
        https: false,
        username: s.username ?? 'admin',
        password: s.password ?? 'secret',
        authMode: 'digest',
        verifyTls: true,
        connectTimeoutMs: s.connectTimeoutMs ?? 2000,
        streamIdleTimeoutMs: s.idleMs ?? 0,
    });
    const manager = new ConnectionManager({
        cameraId: 'cam',
        opener: client,
        retry: new RetryPolicy(20, 100),
        authRetryMs: s.authRetryMs ?? 60_000,
        maxAuthFailures: s.maxAuthFailures ?? 3,
        slowRetryMs: 60_000,
        discoverUnknown: true,
        maxPartBytes: s.maxPartBytes,
        callbacks: {
            onState: st => states.push(st),
            onConnected: () => log.connected++,
            onLive: () => log.live++,
            onDisconnected: () => log.disconnected++,
            onReconnectScheduled: () => undefined,
            onEvent: e => events.push(e),
            onParseError: m => parseErrors.push(m),
        },
    });
    cleanups.push(() => manager.stop());
    return { manager, events, states, parseErrors, log };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise(r => setTimeout(r, 10));
    }
}

describe('ISAPI stream integration (mock camera)', () => {
    it('authenticates with Digest, receives heartbeat and events', async () => {
        const mock = await startMock({
            onStream: res => {
                res.write(multipartPart(heartbeatXml()));
                res.write(multipartPart(alertXml({ eventType: 'linedetection', target: 'human', ruleId: '1' })));
                res.write(multipartPart(alertXml({ eventType: 'fielddetection', target: 'vehicle' })));
            },
        });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.events.length === 3);
        assert.equal(t.events[0].heartbeat, true);
        assert.equal(t.events[1].eventType, 'line_crossing');
        assert.equal(t.events[1].target, 'human');
        assert.equal(t.events[2].eventType, 'intrusion');
        assert.equal(t.log.live, 1);
        assert.ok(t.states.includes('waiting'));
        assert.ok(t.states.includes('receiving'));
    });

    it('wrong password: one controlled attempt, no retry storm', async () => {
        const mock = await startMock();
        const t = createManager(mock.port, { password: 'wrong' });
        t.manager.start();
        await until(() => t.states.includes('authFailed'));
        await new Promise(r => setTimeout(r, 300));
        assert.equal(mock.authedRequests, 1);
        assert.equal(mock.requests, 2);
        assert.equal(t.log.connected, 0);
    });

    it('gives up after the maximum number of auth failures', async () => {
        const mock = await startMock();
        const t = createManager(mock.port, { password: 'wrong', authRetryMs: 30, maxAuthFailures: 3 });
        t.manager.start();
        await until(() => mock.authedRequests >= 3);
        await new Promise(r => setTimeout(r, 300));
        assert.equal(mock.authedRequests, 3);
    });

    it('reports HTTP 403 as permission denied', async () => {
        const mock = await startMock({ mode: '403' });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.states.includes('denied'));
    });

    it('reports HTTP 404 as ISAPI unsupported', async () => {
        const mock = await startMock({ mode: '404' });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.states.includes('unsupported'));
    });

    it('times out when the camera never answers', async () => {
        const mock = await startMock({ mode: 'silent' });
        const t = createManager(mock.port, { connectTimeoutMs: 100 });
        t.manager.start();
        await until(() => t.states.includes('lost'));
    });

    it('reconnects after the camera restarts (stream closed)', async () => {
        const mock = await startMock({
            onStream: (res, n) => {
                res.write(multipartPart(alertXml({ eventType: 'VMD', dateTime: `2026-01-01T00:00:0${n}Z` })));
                if (n === 1) {
                    setTimeout(() => res.destroy(), 30);
                }
            },
        });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.events.length >= 2);
        assert.equal(t.log.disconnected >= 1, true);
        assert.equal(mock.streams >= 2, true);
    });

    it('detects a silently dead stream via the idle timeout and reconnects', async () => {
        const mock = await startMock({
            onStream: res => {
                res.write(multipartPart(heartbeatXml()));
            },
        });
        const t = createManager(mock.port, { idleMs: 150 });
        t.manager.start();
        await until(() => mock.streams >= 2, 4000);
        assert.ok(t.log.disconnected >= 1);
    });

    it('survives a very large message and keeps parsing', async () => {
        const mock = await startMock({
            onStream: res => {
                res.write(multipartPart(Buffer.alloc(3 * 1024 * 1024, 0x41), 'image/jpeg'));
                res.write(multipartPart(alertXml({ eventType: 'VMD' })));
            },
        });
        const t = createManager(mock.port, { maxPartBytes: 1024 * 1024 });
        t.manager.start();
        await until(() => t.events.length === 1, 5000);
        assert.ok(t.parseErrors.length >= 1);
    });

    it('malformed payload is counted and the next event still arrives', async () => {
        const mock = await startMock({
            onStream: res => {
                res.write(multipartPart('<EventNotificationAlert><eventType>'));
                res.write(multipartPart(alertXml({ eventType: 'VMD' })));
            },
        });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.events.length === 1);
        assert.equal(t.parseErrors.length, 1);
    });

    it('multiple cameras are independent', async () => {
        const good = await startMock({ onStream: res => res.write(multipartPart(alertXml({ eventType: 'VMD' }))) });
        const bad = await startMock();
        const a = createManager(good.port);
        const b = createManager(bad.port, { password: 'wrong' });
        b.manager.start();
        a.manager.start();
        await until(() => a.events.length === 1 && b.states.includes('authFailed'));
        assert.equal(b.events.length, 0);
    });

    it('stop() closes the stream and prevents reconnects', async () => {
        const mock = await startMock({ onStream: res => res.write(multipartPart(heartbeatXml())) });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.log.live === 1);
        t.manager.stop();
        const streams = mock.streams;
        await new Promise(r => setTimeout(r, 300));
        assert.equal(mock.streams, streams);
    });

    it('can be restarted after stop (adapter restart)', async () => {
        const mock = await startMock({ onStream: res => res.write(multipartPart(alertXml({ eventType: 'VMD' }))) });
        const t = createManager(mock.port);
        t.manager.start();
        await until(() => t.events.length === 1);
        t.manager.stop();
        t.manager.start();
        await until(() => t.events.length === 2);
    });
});
