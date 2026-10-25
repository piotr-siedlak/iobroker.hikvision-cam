import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildCameraRows, describeScan, expandTargets, MAX_SCAN_ADDRESSES } from '../src/lib/Discovery';
import type { FoundDevice, ScanRequest } from '../src/lib/Discovery';

describe('expandTargets', () => {
    it('expands a /24 without network and broadcast', () => {
        const { hosts, error } = expandTargets('192.168.1.0/24');
        assert.equal(error, undefined);
        assert.equal(hosts.length, 254);
        assert.equal(hosts[0], '192.168.1.1');
        assert.equal(hosts[253], '192.168.1.254');
    });
    it('normalizes a CIDR given with a host address', () => {
        assert.equal(expandTargets('10.0.5.77/30').hosts.join(','), '10.0.5.77,10.0.5.78');
    });
    it('supports short and full ranges and lists, de-duplicated', () => {
        assert.deepEqual(expandTargets('192.168.1.10-12, 192.168.1.12').hosts, ['192.168.1.10', '192.168.1.11', '192.168.1.12']);
        assert.equal(expandTargets('172.16.0.250-172.16.1.5').hosts.length, 12);
    });
    it('rejects public addresses, oversized and malformed input', () => {
        assert.match(expandTargets('8.8.8.0/24').error ?? '', /private/);
        assert.match(expandTargets('10.0.0.0/16').error ?? '', new RegExp(String(MAX_SCAN_ADDRESSES)));
        assert.ok(expandTargets('192.168.1.300').error);
        assert.ok(expandTargets('cam.local').error);
        assert.ok(expandTargets('').error);
        assert.ok(expandTargets('192.168.1.20-10').error);
        assert.match(expandTargets('172.32.0.1').error ?? '', /private/);
    });
});

describe('buildCameraRows', () => {
    const req: ScanRequest = { subnet: '', https: false, port: 80, username: 'viewer', password: 'pw' };
    const found: FoundDevice[] = [
        { host: '192.168.1.10', status: 'ok', deviceName: 'Garage', model: 'DS-2CD2387G2-LU' },
        { host: '192.168.1.11', status: 'ok', deviceName: 'IP CAMERA', model: 'DS-2CD2387G2-LU' },
        { host: '192.168.1.12', status: 'ok', deviceName: 'IP CAMERA', model: 'DS-2CD2387G2-LU' },
        { host: '192.168.1.13', status: 'forbidden' },
        { host: '192.168.1.14', status: 'auth' },
        { host: '192.168.1.20', status: 'ok', deviceName: 'Existing' },
    ];
    const rows = buildCameraRows(found, [{ host: '192.168.1.20', name: 'Gate' }], req, p => `enc:${p}`);

    it('adds usable new devices only, with encrypted shared password', () => {
        assert.deepEqual(
            rows.map(r => r.host),
            ['192.168.1.10', '192.168.1.11', '192.168.1.12', '192.168.1.13'],
        );
        assert.ok(rows.every(r => r.password === 'enc:pw' && r.username === 'viewer' && r.mode === 'stream'));
    });
    it('uses device names, falls back to model and keeps names unique', () => {
        assert.deepEqual(
            rows.map(r => r.name),
            ['Garage', 'DS-2CD2387G2-LU', 'DS-2CD2387G2-LU 12', 'Camera'],
        );
    });
    it('summarizes added and rejected devices', () => {
        const text = describeScan({ scanned: 254, found, timedOut: false }, rows);
        assert.match(text, /Scanned 254/);
        assert.match(text, /Added 4/);
        assert.match(text, /Login rejected \(not added\): 192\.168\.1\.14/);
    });
    it('keeps TLS verification on for HTTP rows and off for scanned HTTPS rows', () => {
        assert.equal(rows[0].verifyTls, true);
        const https = buildCameraRows([found[0]], [], { ...req, https: true, port: 443 }, p => p);
        assert.equal(https[0].verifyTls, false);
        assert.equal(https[0].protocol, 'https');
    });
});
