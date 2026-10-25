import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { PushServer } from '../../src/lib/PushServer';
import type { PushTarget } from '../../src/lib/PushServer';
import type { StreamPart } from '../../src/lib/types';
import { alertXml, BOUNDARY, multipartPart } from '../fixtures';

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const servers: PushServer[] = [];
afterEach(async () => {
    while (servers.length) {
        await servers.pop()!.stop();
    }
});

async function start(host: string, limits: { maxRequestBytes?: number; maxSingleBodyBytes?: number } = {}) {
    const parts: StreamPart[] = [];
    const errors: string[] = [];
    const target: PushTarget = { id: 'cam', host, onPart: p => parts.push(p), onParseError: e => errors.push(e) };
    const server = new PushServer({ port: 0, bind: '127.0.0.1', log: silent, ...limits });
    server.add(target);
    const port = await server.start();
    servers.push(server);
    return { port, parts, errors };
}

function post(port: number, body: Buffer, contentType: string, method = 'POST'): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', method, headers: { 'Content-Type': contentType } }, res => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('error', err => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE' ? resolve(413) : reject(err)));
        req.end(body);
    });
}

describe('PushServer (HTTP listening mode)', () => {
    it('accepts a single XML alert from a configured camera address', async () => {
        const s = await start('127.0.0.1');
        assert.equal(await post(s.port, Buffer.from(alertXml()), 'application/xml'), 200);
        assert.equal(s.parts.length, 1);
        assert.match(s.parts[0].body.toString(), /linedetection/);
    });

    it('accepts multipart pushes with images', async () => {
        const s = await start('127.0.0.1');
        const body = Buffer.concat([
            multipartPart(alertXml({ eventType: 'fielddetection' })),
            multipartPart(Buffer.alloc(50_000, 0xff), 'image/jpeg'),
            Buffer.from(`--${BOUNDARY}--\r\n`),
        ]);
        assert.equal(await post(s.port, body, `multipart/form-data; boundary=${BOUNDARY}`), 200);
        assert.equal(s.parts.length, 2);
        assert.equal(s.parts[1].contentType, 'image/jpeg');
    });

    it('rejects pushes from unconfigured addresses', async () => {
        const s = await start('192.0.2.50');
        assert.equal(await post(s.port, Buffer.from(alertXml()), 'application/xml'), 403);
        assert.equal(s.parts.length, 0);
    });

    it('rejects non-POST methods', async () => {
        const s = await start('127.0.0.1');
        assert.equal(await post(s.port, Buffer.alloc(0), 'text/plain', 'GET'), 405);
    });

    it('rejects oversized bodies without delivering them', async () => {
        const s = await start('127.0.0.1', { maxSingleBodyBytes: 1000 });
        const status = await post(s.port, Buffer.alloc(100_000, 0x41), 'application/xml');
        assert.equal(status, 413);
        assert.equal(s.parts.length, 0);
        assert.equal(s.errors.length, 1);
    });

    it('fails to start on a port that is already in use', async () => {
        const s = await start('127.0.0.1');
        const second = new PushServer({ port: s.port, bind: '127.0.0.1', log: silent });
        await assert.rejects(() => second.start());
    });
});
