import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CameraRuntime } from '../src/lib/CameraRuntime';
import type { NormalizedCameraConfig } from '../src/lib/config';
import type { StreamHandlers, StreamOpener } from '../src/lib/CameraClient';
import type { IoApi, LogApi, StateVal } from '../src/lib/io';
import { alertXml, BOUNDARY, multipartPart } from './fixtures';

function fakeIo(initial: Record<string, StateVal> = {}) {
    const store = new Map<string, StateVal>(Object.entries(initial));
    const writes: string[] = [];
    const files = new Map<string, Buffer>();
    const io: IoApi = {
        extendObject: async () => undefined,
        setState: async (id, val, opts) => {
            if (!opts?.force && store.get(id) === val) {
                return;
            }
            store.set(id, val);
            writes.push(id);
        },
        getNumber: async id => {
            const v = store.get(id);
            return typeof v === 'number' ? v : undefined;
        },
        getString: async id => {
            const v = store.get(id);
            return typeof v === 'string' ? v : undefined;
        },
        writeFile: async (name, data) => {
            files.set(name, data);
            return `files/${name}`;
        },
        listStates: async prefix => [...store.keys()].filter(k => k.startsWith(prefix)),
    };
    return { io, store, writes, files };
}

const log: LogApi = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function cfg(over: Partial<NormalizedCameraConfig> = {}): NormalizedCameraConfig {
    return {
        id: 'gate', name: 'Gate', host: '192.0.2.10', https: false, port: 80, username: 'u', password: 'p',
        authMode: 'digest', verifyTls: true, reconnectIntervalMs: 1000, alarmTimeoutMs: 60_000, streamTimeoutMs: 60_000,
        eventFilter: new Set(), discoverUnknown: true, diagnostic: false, mode: 'stream', snapshot: false, ...over,
    };
}

const snapshotRequests: string[] = [];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 1)]);

function setup(initial: Record<string, StateVal> = {}, over: Partial<NormalizedCameraConfig> = {}, historySize = 20) {
    const f = fakeIo(initial);
    let handlers!: StreamHandlers;
    const opener: StreamOpener = { open: h => ((handlers = h), { close: () => undefined }) };
    const rt = new CameraRuntime(cfg(over), f.io, log, {
        opener,
        historySize,
        fetchText: async () => '<DeviceInfo><model>DS-TEST</model><firmwareVersion>V1</firmwareVersion></DeviceInfo>',
        fetchBuffer: async path => (snapshotRequests.push(path), { body: JPEG, contentType: 'image/jpeg' }),
    });
    const feed = (...xml: string[]) => handlers.onData(Buffer.concat(xml.map(x => multipartPart(x))));
    const open = () => handlers.onOpen({ contentType: `multipart/mixed; boundary=${BOUNDARY}`, boundary: BOUNDARY });
    return { ...f, rt, feed, open, drop: () => handlers.onClose({ kind: 'network', message: 'Stream closed by camera' }) };
}

async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !cond(); i++) {
        await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(cond(), 'condition not met');
}

const E = 'cameras.gate.events';

describe('CameraRuntime (fake ioBroker)', () => {
    it('publishes events, human target, last event and device info', async () => {
        const t = setup();
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed(alertXml({ eventType: 'linedetection', target: 'human', ruleId: '2', direction: 'right' }));
        await until(() => t.store.get('cameras.gate.lastEvent.sequence') === 1);
        await until(() => t.store.get('cameras.gate.info.model') === 'DS-TEST');
        assert.equal(t.store.get('cameras.gate.info.connection'), true);
        assert.equal(t.store.get(`${E}.line_crossing.active`), true);
        assert.equal(t.store.get(`${E}.line_crossing.count`), 1);
        assert.equal(t.store.get(`${E}.line_crossing.human.active`), true);
        assert.equal(t.store.get(`${E}.line_crossing.vehicle.active`), false);
        assert.equal(t.store.get(`${E}.line_crossing.rules.ch1_r2.active`), true);
        const json = JSON.parse(String(t.store.get('cameras.gate.lastEvent.json')));
        assert.equal(json.rawEventType, 'linedetection');
        assert.equal(json.direction, 'right');
        await t.rt.stop();
    });

    it('disconnect makes alarms unknown (null/invalid), not inactive', async () => {
        const t = setup();
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed(alertXml());
        await until(() => t.store.get(`${E}.line_crossing.active`) === true);
        t.drop();
        await until(() => t.store.get(`${E}.line_crossing.active`) === null);
        assert.equal(t.store.get(`${E}.line_crossing.state`), 'unknown');
        assert.equal(t.store.get(`${E}.line_crossing.valid`), false);
        assert.equal(t.store.get('cameras.gate.info.connection'), false);
        assert.match(String(t.store.get('cameras.gate.info.lastError')), /closed/);
        await t.rt.stop();
    });

    it('counters continue after a restart and stale alarms are reset to unknown', async () => {
        const t = setup({ [`${E}.line_crossing.active`]: true, [`${E}.line_crossing.state`]: 'active', [`${E}.line_crossing.count`]: 5, 'cameras.gate.info.eventsReceived': 10 });
        await t.rt.init();
        assert.equal(t.store.get(`${E}.line_crossing.active`), null);
        assert.equal(t.store.get(`${E}.line_crossing.state`), 'unknown');
        t.rt.start();
        t.open();
        t.feed(alertXml());
        await until(() => t.store.get(`${E}.line_crossing.count`) === 6);
        await until(() => t.store.get('cameras.gate.info.eventsReceived') === 11);
        await t.rt.stop();
    });

    it('event filter ignores matching events; unknown events are still exposed', async () => {
        const t = setup({}, { eventFilter: new Set(['motion']) });
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed(alertXml({ eventType: 'VMD' }), alertXml({ eventType: 'Mystery Alarm' }));
        await until(() => t.store.get(`${E}.mystery_alarm.active`) === true);
        assert.equal(t.store.has(`${E}.motion.active`), false);
        await t.rt.stop();
    });

    it('a malformed payload increments parseErrors and processing continues', async () => {
        const t = setup();
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed('<EventNotificationAlert><eventType>', alertXml({ eventType: 'VMD' }));
        await until(() => t.store.get(`${E}.motion.active`) === true);
        assert.equal(t.store.get('cameras.gate.info.parseErrors'), 1);
        await t.rt.stop();
    });
});

describe('CameraRuntime push mode', () => {
    it('stays unknown until the first push, then tracks alarms', async () => {
        const t = setup({ [`${E}.intrusion.active`]: true }, { mode: 'push' });
        await t.rt.init();
        t.rt.start();
        assert.equal(t.store.get(`${E}.intrusion.active`), null);
        await until(() => t.store.get('cameras.gate.info.status') === 'push: waiting for first alert');
        const target = t.rt.pushTarget();
        target.onPart({ contentType: 'application/xml', headers: {}, body: Buffer.from(alertXml({ eventType: 'fielddetection', target: 'vehicle' })) });
        await until(() => t.store.get(`${E}.intrusion.active`) === true);
        assert.equal(t.store.get(`${E}.intrusion.vehicle.active`), true);
        assert.equal(t.store.get('cameras.gate.info.connection'), true);
        assert.equal(t.store.get('cameras.gate.info.status'), 'push: receiving');
        await t.rt.stop();
    });
});

describe('CameraRuntime history and snapshots', () => {
    it('keeps a bounded, restart-safe trigger history (newest first)', async () => {
        const t = setup({ 'cameras.gate.lastEvent.history': JSON.stringify([{ sequence: 1, eventType: 'motion' }]) }, {}, 2);
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed(alertXml({ eventType: 'VMD', ruleId: '1' }), alertXml({ eventType: 'linedetection', target: 'human' }));
        await until(() => JSON.parse(String(t.store.get('cameras.gate.lastEvent.history'))).length === 2 && t.store.get('cameras.gate.lastEvent.sequence') === 2);
        const h = JSON.parse(String(t.store.get('cameras.gate.lastEvent.history')));
        assert.deepEqual(h.map((e: { eventType: string }) => e.eventType), ['line_crossing', 'motion']);
        assert.equal(h[0].target, 'human');
        await t.rt.stop();
    });

    it('stores one snapshot per trigger from the right channel when enabled, rate limited', async () => {
        snapshotRequests.length = 0;
        const t = setup({}, { snapshot: true });
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed(alertXml({ eventType: 'fielddetection', channel: 2 }), alertXml({ eventType: 'VMD', channel: 2 }));
        await until(() => t.store.get('cameras.gate.lastEvent.snapshot') === 'files/gate/latest.jpg');
        assert.deepEqual(snapshotRequests, ['/ISAPI/Streaming/channels/201/picture']);
        assert.equal(t.files.get('gate/latest.jpg')?.length, JPEG.length);
        assert.ok(t.store.get('cameras.gate.lastEvent.snapshotTime'));
        await t.rt.stop();
    });

    it('does not request snapshots unless enabled', async () => {
        snapshotRequests.length = 0;
        const t = setup();
        await t.rt.init();
        t.rt.start();
        t.open();
        t.feed(alertXml());
        await until(() => t.store.get('cameras.gate.lastEvent.sequence') === 1);
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(snapshotRequests, []);
        assert.equal(t.files.size, 0);
        await t.rt.stop();
    });
});
