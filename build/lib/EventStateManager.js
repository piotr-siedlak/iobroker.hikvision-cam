"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStateManager = void 0;
const EventDeduplicator_1 = require("./EventDeduplicator");
const util_1 = require("./util");
/**
 * Per-camera alarm lifecycle. Every (event type, channel, rule, region)
 * combination is an independent slot, so multiple rules never overwrite each
 * other. Slot states: inactive / active / unknown (stream down).
 *
 * A *new trigger* (counted, reported via onEvent 'trigger') is:
 *  - an active notice while the slot was not active, or
 *  - an active notice carrying a different event id than the previous one, or
 *  - an active notice whose activePostCount did not increase (counter restarted).
 * Any other active notice is a retransmission that only extends the alarm.
 */
class EventStateManager {
    opts;
    types = new Map();
    dedup = new EventDeduplicator_1.EventDeduplicator();
    now;
    connected = false;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
    }
    handle(ev) {
        const ts = this.types.get(ev.eventType);
        const key = this.slotKey(ev);
        if (ev.heartbeat) {
            // Keep-alive: only clears a real active video-loss alarm, never creates state.
            const slot = ts?.slots.get(key);
            if (ts && slot && slot.state === 'active') {
                this.clear(ev.eventType, ts, slot, 'clear');
                this.opts.onEvent?.(ev, 'clear');
            }
            else {
                this.opts.onEvent?.(ev, 'heartbeat');
            }
            return;
        }
        const dedupKey = [
            ev.eventType,
            key,
            ev.eventState,
            ev.eventId ?? '',
            ev.cameraTimestamp ?? '',
            ev.activePostCount ?? '',
        ].join('|');
        if (this.dedup.isDuplicate(dedupKey, this.now())) {
            this.opts.onEvent?.(ev, 'duplicate');
            return;
        }
        const typeState = ts ?? this.createType(ev.eventType);
        let slot = typeState.slots.get(key);
        const created = !slot;
        if (!slot) {
            slot = {
                key,
                channelId: ev.channelId,
                ruleId: ev.ruleId,
                regionId: ev.regionId,
                state: this.connected ? 'inactive' : 'unknown',
                target: 'none',
                count: 0,
            };
            typeState.slots.set(key, slot);
        }
        if (ev.eventState === 'active') {
            this.onActive(ev, typeState, slot);
        }
        else if (slot.state === 'active') {
            this.clear(ev.eventType, typeState, slot, 'clear');
            this.opts.onEvent?.(ev, 'clear');
        }
        else if (created || slot.state === 'unknown') {
            slot.state = 'inactive';
            this.emit(ev.eventType, typeState, slot, 'first-seen');
            this.opts.onEvent?.(ev, 'noop');
        }
        else {
            this.opts.onEvent?.(ev, 'noop');
        }
    }
    /** Stream connected: unknown slots become inactive. Disconnected: every slot becomes unknown. */
    setConnected(connected) {
        this.connected = connected;
        for (const [eventType, ts] of this.types) {
            for (const slot of ts.slots.values()) {
                this.stopTimer(slot);
                const next = connected ? 'inactive' : 'unknown';
                if (slot.state === next || (connected && slot.state === 'active')) {
                    continue;
                }
                slot.state = next;
                slot.target = 'none';
                this.emit(eventType, ts, slot, connected ? 'connected' : 'disconnected');
            }
        }
    }
    dispose() {
        for (const ts of this.types.values()) {
            for (const slot of ts.slots.values()) {
                this.stopTimer(slot);
            }
        }
    }
    onActive(ev, ts, slot) {
        const wasActive = slot.state === 'active';
        const isTrigger = !wasActive ||
            (ev.eventId !== undefined && ev.eventId !== slot.lastEventId) ||
            (ev.activePostCount !== undefined &&
                slot.lastPost !== undefined &&
                ev.activePostCount <= slot.lastPost);
        slot.lastEventId = ev.eventId;
        slot.lastPost = ev.activePostCount;
        this.arm(ev.eventType, ts, slot);
        if (!isTrigger) {
            if (ev.target !== 'none' && slot.target !== ev.target) {
                slot.target = ev.target;
                this.noteTarget(ts, ev.target);
                this.emit(ev.eventType, ts, slot, 'refresh');
            }
            this.opts.onEvent?.(ev, 'refresh');
            return;
        }
        slot.state = 'active';
        slot.target = ev.target;
        slot.count++;
        slot.lastTriggered = ev.receivedAt;
        ts.count++;
        ts.lastTriggered = ev.receivedAt;
        this.noteTarget(ts, ev.target);
        this.emit(ev.eventType, ts, slot, 'trigger');
        this.opts.onEvent?.(ev, 'trigger');
    }
    noteTarget(ts, target) {
        if (target !== 'none') {
            ts.lastTarget = target;
            if (target === 'human' || target === 'vehicle') {
                ts.targetSeen = true;
            }
        }
    }
    clear(eventType, ts, slot, reason) {
        this.stopTimer(slot);
        slot.state = 'inactive';
        slot.target = 'none';
        slot.lastPost = undefined;
        this.emit(eventType, ts, slot, reason);
    }
    arm(eventType, ts, slot) {
        this.stopTimer(slot);
        slot.timer = setTimeout(() => {
            slot.timer = undefined;
            if (slot.state === 'active') {
                this.clear(eventType, ts, slot, 'timeout');
            }
        }, this.opts.timeoutMs);
        slot.timer.unref?.();
    }
    stopTimer(slot) {
        if (slot.timer) {
            clearTimeout(slot.timer);
            slot.timer = undefined;
        }
    }
    createType(eventType) {
        const ts = { slots: new Map(), count: 0, lastTarget: 'none', targetSeen: false };
        this.types.set(eventType, ts);
        return ts;
    }
    slotKey(ev) {
        let key = `ch${ev.channelId}`;
        if (ev.ruleId !== undefined) {
            key += `_r${(0, util_1.sanitizeId)(ev.ruleId, 24)}`;
        }
        if (ev.regionId !== undefined) {
            key += `_g${(0, util_1.sanitizeId)(ev.regionId, 24)}`;
        }
        return key;
    }
    emit(eventType, ts, slot, reason) {
        this.opts.onChange({
            cameraId: this.opts.cameraId,
            eventType,
            aggregate: this.aggregate(ts),
            slot: {
                key: slot.key,
                channelId: slot.channelId,
                ruleId: slot.ruleId,
                regionId: slot.regionId,
                state: slot.state,
                target: slot.target,
                count: slot.count,
                lastTriggered: slot.lastTriggered,
                detail: slot.ruleId !== undefined || slot.regionId !== undefined || slot.channelId !== 1,
            },
            reason,
        });
    }
    aggregate(ts) {
        let anyActive = false;
        let anyUnknown = false;
        let human = false;
        let vehicle = false;
        for (const slot of ts.slots.values()) {
            if (slot.state === 'active') {
                anyActive = true;
                human ||= slot.target === 'human';
                vehicle ||= slot.target === 'vehicle';
            }
            else if (slot.state === 'unknown') {
                anyUnknown = true;
            }
        }
        const state = anyActive ? 'active' : anyUnknown ? 'unknown' : 'inactive';
        const unknown = state === 'unknown';
        return {
            state,
            active: unknown ? null : anyActive,
            valid: !unknown,
            human: unknown ? null : human,
            vehicle: unknown ? null : vehicle,
            count: ts.count,
            lastTriggered: ts.lastTriggered,
            lastTarget: ts.lastTarget,
            targetSeen: ts.targetSeen,
        };
    }
}
exports.EventStateManager = EventStateManager;
