import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EventStateManager } from '../src/lib/EventStateManager';
import type { EventOutcome, StateChange } from '../src/lib/EventStateManager';
import type { HikvisionEvent } from '../src/lib/types';

let seq = 0;
function ev(o: Partial<HikvisionEvent> = {}): HikvisionEvent {
    seq++;
    return {
        cameraId: 'cam',
        eventType: 'line_crossing',
        rawEventType: 'linedetection',
        eventState: 'active',
        target: 'none',
        channelId: 1,
        receivedAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
        cameraTimestamp: `t${seq}`, // distinct per call so the deduplicator never merges test events
        heartbeat: false,
        extra: {},
        ...o,
    };
}

function setup(timeoutMs = 60_000) {
    const changes: StateChange[] = [];
    const outcomes: EventOutcome[] = [];
    const m = new EventStateManager({
        cameraId: 'cam',
        timeoutMs,
        onChange: c => changes.push(c),
        onEvent: (_e, o) => outcomes.push(o),
    });
    m.setConnected(true);
    const last = () => changes[changes.length - 1];
    return { m, changes, outcomes, last };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('EventStateManager', () => {
    it('active then inactive', () => {
        const { m, last } = setup();
        m.handle(ev());
        assert.equal(last().aggregate.state, 'active');
        assert.equal(last().aggregate.active, true);
        m.handle(ev({ eventState: 'inactive' }));
        assert.equal(last().aggregate.state, 'inactive');
        assert.equal(last().aggregate.active, false);
        m.dispose();
    });

    it('repeated active notifications refresh without a new trigger', () => {
        const { m, outcomes, last } = setup();
        m.handle(ev({ activePostCount: 1 }));
        m.handle(ev({ activePostCount: 2 }));
        m.handle(ev({ activePostCount: 3 }));
        assert.deepEqual(outcomes, ['trigger', 'refresh', 'refresh']);
        assert.equal(last().aggregate.count, 1);
        m.dispose();
    });

    it('two consecutive crossings are two triggers even while already active', () => {
        const { m, outcomes, last } = setup();
        m.handle(ev({ activePostCount: 1 }));
        m.handle(ev({ activePostCount: 1 })); // counter restarted -> new alarm
        assert.deepEqual(outcomes, ['trigger', 'trigger']);
        assert.equal(last().aggregate.count, 2);
        m.dispose();
    });

    it('a different event id is a new trigger', () => {
        const { m, outcomes } = setup();
        m.handle(ev({ eventId: 'a' }));
        m.handle(ev({ eventId: 'b' }));
        m.handle(ev({ eventId: 'b' }));
        assert.deepEqual(outcomes, ['trigger', 'trigger', 'refresh']);
        m.dispose();
    });

    it('suppresses byte-identical duplicates but not distinct timestamps', () => {
        const { m, outcomes } = setup();
        const e = ev({ activePostCount: 1 });
        m.handle(e);
        m.handle({ ...e });
        assert.deepEqual(outcomes, ['trigger', 'duplicate']);
        m.dispose();
    });

    it('clears an active alarm after the inactivity timeout', async () => {
        const { m, last } = setup(40);
        m.handle(ev());
        assert.equal(last().aggregate.active, true);
        await sleep(120);
        assert.equal(last().reason, 'timeout');
        assert.equal(last().aggregate.active, false);
        m.dispose();
    });

    it('refresh extends the timeout', async () => {
        const { m, last } = setup(80);
        m.handle(ev({ activePostCount: 1 }));
        await sleep(50);
        m.handle(ev({ activePostCount: 2 }));
        await sleep(50);
        assert.equal(last().aggregate.active, true);
        await sleep(100);
        assert.equal(last().aggregate.active, false);
        m.dispose();
    });

    it('one-shot event: counted and timestamped, not treated as latched', async () => {
        const { m, last } = setup(30);
        m.handle(ev({ eventType: 'face_detection' }));
        assert.equal(last().aggregate.count, 1);
        assert.ok(last().aggregate.lastTriggered);
        await sleep(100);
        assert.equal(last().aggregate.active, false);
        assert.equal(last().aggregate.count, 1);
        m.dispose();
    });

    it('exposes human and vehicle only when reported', () => {
        const { m, last } = setup();
        m.handle(ev());
        assert.equal(last().aggregate.targetSeen, false);
        m.handle(ev({ eventState: 'inactive' }));
        m.handle(ev({ target: 'human' }));
        assert.equal(last().aggregate.human, true);
        assert.equal(last().aggregate.vehicle, false);
        assert.equal(last().aggregate.lastTarget, 'human');
        m.handle(ev({ eventState: 'inactive' }));
        m.handle(ev({ target: 'vehicle' }));
        assert.equal(last().aggregate.human, false);
        assert.equal(last().aggregate.vehicle, true);
        m.dispose();
    });

    it('multiple rules keep independent lifecycles', () => {
        const { m, last } = setup();
        m.handle(ev({ ruleId: '1' }));
        m.handle(ev({ ruleId: '2' }));
        assert.equal(last().aggregate.active, true);
        m.handle(ev({ ruleId: '1', eventState: 'inactive' }));
        assert.equal(last().slot.state, 'inactive');
        assert.equal(last().aggregate.active, true, 'rule 2 is still active');
        assert.equal(last().slot.detail, true);
        m.handle(ev({ ruleId: '2', eventState: 'inactive' }));
        assert.equal(last().aggregate.active, false);
        m.dispose();
    });

    it('channels are independent', () => {
        const { m, last } = setup();
        m.handle(ev({ channelId: 1 }));
        m.handle(ev({ channelId: 2 }));
        m.handle(ev({ channelId: 1, eventState: 'inactive' }));
        assert.equal(last().aggregate.active, true);
        m.dispose();
    });

    it('lost stream during an alarm -> unknown, never "inactive"', () => {
        const { m, last } = setup();
        m.handle(ev());
        m.setConnected(false);
        assert.equal(last().aggregate.state, 'unknown');
        assert.equal(last().aggregate.active, null);
        assert.equal(last().aggregate.valid, false);
        assert.equal(last().reason, 'disconnected');
        m.dispose();
    });

    it('reconnect restores tracking', () => {
        const { m, last } = setup();
        m.handle(ev());
        m.setConnected(false);
        m.setConnected(true);
        assert.equal(last().aggregate.state, 'inactive');
        assert.equal(last().aggregate.valid, true);
        m.handle(ev());
        assert.equal(last().aggregate.active, true);
        m.dispose();
    });

    it('a timer never fires after disconnect', async () => {
        const { m, changes } = setup(30);
        m.handle(ev());
        m.setConnected(false);
        const n = changes.length;
        await sleep(100);
        assert.equal(changes.length, n);
        m.dispose();
    });

    it('heartbeat never creates state', () => {
        const { m, changes, outcomes } = setup();
        m.handle(ev({ eventType: 'video_loss', rawEventType: 'videoloss', eventState: 'inactive', heartbeat: true }));
        assert.equal(changes.length, 0);
        assert.deepEqual(outcomes, ['heartbeat']);
        m.dispose();
    });

    it('heartbeat clears a real active video loss', () => {
        const { m, last } = setup();
        m.handle(ev({ eventType: 'video_loss', rawEventType: 'videoloss', eventState: 'active' }));
        assert.equal(last().aggregate.active, true);
        m.handle(ev({ eventType: 'video_loss', rawEventType: 'videoloss', eventState: 'inactive', heartbeat: true }));
        assert.equal(last().aggregate.active, false);
        m.dispose();
    });
});
