import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock ISAPI camera: HTTP Digest + multipart alertStream. All data is synthetic.

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
const REALM = 'mock-camera';
const NONCE = 'a1b2c3d4e5f6';

export interface MockOptions {
    user?: string;
    pass?: string;
    mode?: 'stream' | '403' | '404' | 'silent';
    onStream?: (res: http.ServerResponse, connection: number) => void;
    /** Response of /ISAPI/System/deviceInfo for authenticated requests. Default: ok. */
    deviceInfo?: 'ok' | '403';
}

export interface Mock {
    port: number;
    requests: number;
    authedRequests: number;
    streams: number;
    close(): Promise<void>;
}

export type Cleanups = Array<() => void | Promise<void>>;

export async function startMock(o: MockOptions = {}, cleanups?: Cleanups): Promise<Mock> {
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
        if (req.url === '/ISAPI/System/deviceInfo') {
            if (o.deviceInfo === '403') {
                res.writeHead(403).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/xml' }).end(
                '<?xml version="1.0" encoding="UTF-8"?><DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><deviceName>Mock</deviceName><model>DS-MOCK-1</model><firmwareVersion>V9.9.9</firmwareVersion></DeviceInfo>',
            );
            return;
        }
        if (req.url !== '/ISAPI/Event/notification/alertStream') {
            res.writeHead(404).end();
            return;
        }
        const connection = ++state.streams;
        res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=boundary', Connection: 'keep-alive' });
        res.flushHeaders(); // like a real camera: headers go out before the first event
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
    cleanups?.push(() => mock.close());
    return mock;
}
