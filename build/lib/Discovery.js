"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SCAN_ADDRESSES = void 0;
exports.expandTargets = expandTargets;
exports.scanHosts = scanHosts;
exports.buildCameraRows = buildCameraRows;
exports.describeScan = describeScan;
const net = __importStar(require("node:net"));
const CameraClient_1 = require("./CameraClient");
const xml_1 = require("./xml");
exports.MAX_SCAN_ADDRESSES = 1024;
function ipToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4 || !net.isIPv4(ip)) {
        return undefined;
    }
    return parts.reduce((n, p) => n * 256 + parseInt(p, 10), 0);
}
function intToIp(n) {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function isPrivate(n) {
    return (n >>> 24 === 10 || // 10.0.0.0/8
        (n >>> 20 === (172 * 16 + 1)) || // 172.16.0.0/12
        n >>> 16 === 192 * 256 + 168 // 192.168.0.0/16
    );
}
/**
 * Expand the user's subnet/range specification into IPv4 addresses.
 * Only private (RFC 1918) addresses, at most MAX_SCAN_ADDRESSES in total.
 */
function expandTargets(spec) {
    const hosts = [];
    const tokens = spec
        .split(/[,\s;]+/)
        .map(t => t.trim())
        .filter(Boolean);
    if (!tokens.length) {
        return { hosts, error: 'Enter a subnet such as 192.168.1.0/24 or a range such as 192.168.1.10-60' };
    }
    const add = (from, to) => {
        if (to < from) {
            return 'Range end is before range start';
        }
        if (hosts.length + (to - from + 1) > exports.MAX_SCAN_ADDRESSES) {
            return `At most ${exports.MAX_SCAN_ADDRESSES} addresses can be scanned at once (use /22 or smaller)`;
        }
        for (let n = from; n <= to; n++) {
            if (!isPrivate(n)) {
                return `${intToIp(n)} is not a private (LAN) address; only 10.x, 172.16-31.x and 192.168.x can be scanned`;
            }
            hosts.push(intToIp(n));
        }
        return undefined;
    };
    for (const token of tokens) {
        let err;
        const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(token);
        const range = /^(\d+\.\d+\.\d+\.\d+)-(\d+(?:\.\d+\.\d+\.\d+)?)$/.exec(token);
        if (cidr) {
            const base = ipToInt(cidr[1]);
            const prefix = parseInt(cidr[2], 10);
            if (base === undefined || prefix < 0 || prefix > 32) {
                return { hosts: [], error: `Invalid subnet ${token}` };
            }
            const size = 2 ** (32 - prefix);
            const network = base - (base % size);
            // skip network and broadcast address for normal subnets
            err = size > 2 ? add(network + 1, network + size - 2) : add(network, network + size - 1);
        }
        else if (range) {
            const start = ipToInt(range[1]);
            const endText = range[2].includes('.') ? range[2] : `${range[1].split('.').slice(0, 3).join('.')}.${range[2]}`;
            const end = ipToInt(endText);
            if (start === undefined || end === undefined) {
                return { hosts: [], error: `Invalid range ${token}` };
            }
            err = add(start, end);
        }
        else {
            const single = ipToInt(token);
            if (single === undefined) {
                return { hosts: [], error: `"${token}" is not an IPv4 address, subnet or range` };
            }
            err = add(single, single);
        }
        if (err) {
            return { hosts: [], error: err };
        }
    }
    return { hosts: [...new Set(hosts)] };
}
function probePort(host, port, timeoutMs) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}
/**
 * Probe each address: TCP connect, then one read-only GET of
 * /ISAPI/System/deviceInfo with HTTP Digest (credentials are never sent with
 * Basic, so devices that only offer Basic never see the password).
 */
async function scanHosts(hosts, req, opts = {}) {
    const concurrency = opts.concurrency ?? 32;
    const probeTimeout = opts.probeTimeoutMs ?? 700;
    const requestTimeout = opts.requestTimeoutMs ?? 5000;
    const deadline = Date.now() + (opts.deadlineMs ?? 100_000);
    const found = [];
    let next = 0;
    let scanned = 0;
    let timedOut = false;
    const check = async (host) => {
        if (!(await probePort(host, req.port, probeTimeout))) {
            return;
        }
        const client = new CameraClient_1.CameraClient({
            host,
            port: req.port,
            https: req.https,
            username: req.username,
            password: req.password,
            authMode: 'digest',
            verifyTls: false, // discovery only; the added camera keeps certificate verification on
            connectTimeoutMs: requestTimeout,
            streamIdleTimeoutMs: 0,
        });
        try {
            const root = (0, xml_1.parseXml)(await client.getText(CameraClient_1.DEVICE_INFO_PATH));
            if (root.name !== 'DeviceInfo') {
                return;
            }
            const f = new Map();
            (0, xml_1.flattenXml)(root, f);
            found.push({
                host,
                status: 'ok',
                model: f.get('model'),
                deviceName: f.get('devicename'),
                deviceType: f.get('devicetype'),
                firmware: f.get('firmwareversion'),
            });
        }
        catch (err) {
            if (err instanceof CameraClient_1.RequestError && (err.kind === 'auth' || err.kind === 'forbidden')) {
                found.push({ host, status: err.kind === 'auth' ? 'auth' : 'forbidden' });
            }
            // anything else (404, not XML, timeouts): not an ISAPI device
        }
    };
    const worker = async () => {
        while (next < hosts.length) {
            if (Date.now() > deadline) {
                timedOut = true;
                return;
            }
            const host = hosts[next++];
            scanned++;
            await check(host);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    found.sort((a, b) => (ipToInt(a.host) ?? 0) - (ipToInt(b.host) ?? 0));
    return { scanned, found, timedOut };
}
const GENERIC_NAMES = /^(ip ?camera|camera|embedded net dvr|network video recorder|)$/i;
/**
 * Build new camera rows for every usable device that is not configured yet.
 * Passwords go through `encrypt` so the rows match what Admin stores for the
 * encrypted password column.
 */
function buildCameraRows(found, existingRows, req, encrypt) {
    const hosts = new Set(existingRows.map(r => String(r.host ?? '').trim().toLowerCase()));
    const names = new Set(existingRows.map(r => String(r.name ?? '').trim().toLowerCase()));
    const rows = [];
    for (const d of found) {
        if (d.status === 'auth' || hosts.has(d.host)) {
            continue;
        }
        hosts.add(d.host);
        const base = d.deviceName && !GENERIC_NAMES.test(d.deviceName.trim()) ? d.deviceName.trim() : d.model || 'Camera';
        let name = base;
        if (names.has(name.toLowerCase())) {
            name = `${base} ${d.host.split('.').pop()}`;
        }
        names.add(name.toLowerCase());
        rows.push({
            enabled: true,
            name,
            mode: 'stream',
            host: d.host,
            protocol: req.https ? 'https' : 'http',
            port: req.port,
            username: req.username,
            password: req.password ? encrypt(req.password) : '',
            authMode: 'digest',
            // HTTPS cameras found by a scan almost always use self-signed certificates
            verifyTls: !req.https,
            snapshot: false,
            alarmTimeout: 5,
            reconnectInterval: 5,
            streamTimeout: 60,
            eventFilter: '',
            discoverUnknown: true,
            diagnostic: false,
        });
    }
    return rows;
}
function describeScan(result, added) {
    const lines = [`Scanned ${result.scanned} address(es): ${result.found.length} ISAPI device(s) answered.`];
    if (added.length) {
        lines.push(`Added ${added.length}: ${added.map(r => `${String(r.name)} (${String(r.host)})`).join(', ')}.`);
    }
    const rejected = result.found.filter(d => d.status === 'auth').map(d => d.host);
    if (rejected.length) {
        lines.push(`Login rejected (not added): ${rejected.join(', ')}.`);
    }
    if (result.timedOut) {
        lines.push('The scan hit its time limit; scan a smaller range to cover the rest.');
    }
    return lines.join(' ');
}
