"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_MAP = exports.PayloadError = void 0;
exports.normalizeEventType = normalizeEventType;
exports.normalizeTarget = normalizeTarget;
exports.parsePart = parsePart;
exports.fieldsToEvent = fieldsToEvent;
const xml_1 = require("./xml");
const util_1 = require("./util");
class PayloadError extends Error {
}
exports.PayloadError = PayloadError;
/**
 * Raw ISAPI event type (lower-case) -> normalized ioBroker name.
 * Derived from public ISAPI documentation and open-source integrations;
 * not yet verified against every camera model/firmware.
 */
exports.EVENT_MAP = {
    vmd: 'motion',
    linedetection: 'line_crossing',
    fielddetection: 'intrusion',
    regionentrance: 'region_entrance',
    regionexiting: 'region_exit',
    loitering: 'loitering',
    facedetection: 'face_detection',
    peoplegathering: 'people_gathering',
    unattendedbaggage: 'unattended_baggage',
    attendedbaggage: 'object_removal',
    scenechangedetection: 'scene_change',
    shelteralarm: 'tampering',
    videoloss: 'video_loss',
    defocus: 'defocus',
    audioexception: 'audio_exception',
    pir: 'pir',
    io: 'alarm_input',
    diskfull: 'system_exception',
    diskerror: 'system_exception',
    nicbroken: 'system_exception',
    ipconflict: 'system_exception',
    illaccess: 'system_exception',
    raidexception: 'system_exception',
};
function normalizeEventType(raw) {
    const mapped = exports.EVENT_MAP[raw.toLowerCase()];
    return mapped ? { name: mapped, known: true } : { name: (0, util_1.sanitizeId)(raw), known: false };
}
function normalizeTarget(raw) {
    if (!raw) {
        return 'none';
    }
    const t = raw.toLowerCase();
    if (/^(human|person|people|pedestrian)/.test(t)) {
        return 'human';
    }
    if (/^(vehicle|car|truck|bus|motor)/.test(t)) {
        return 'vehicle';
    }
    return 'other';
}
/** Parse one stream part into flat lower-cased fields; null for non-event parts (images, unknown binary). */
function parsePart(part) {
    const ct = part.contentType.toLowerCase();
    if (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/')) {
        return null;
    }
    const text = part.body.toString('utf8').trimStart();
    const fields = new Map();
    try {
        if (text.startsWith('<')) {
            (0, xml_1.flattenXml)((0, xml_1.parseXml)(text), fields);
            return fields;
        }
        if (text.startsWith('{') || text.startsWith('[')) {
            (0, xml_1.flattenJson)(JSON.parse(text), fields);
            return fields;
        }
    }
    catch (err) {
        throw new PayloadError(`Malformed payload: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ct.includes('xml') || ct.includes('json')) {
        throw new PayloadError('Payload is neither valid XML nor JSON');
    }
    return null;
}
const CONSUMED = new Set([
    'eventtype',
    'eventstate',
    'channelid',
    'dynchannelid',
    'datetime',
    'activepostcount',
    'eventdescription',
    'ruleid',
    'regionid',
    'targettype',
    'detectiontarget',
    'direction',
    'eventid',
    'uuid',
]);
const PRIVATE_KEY = /pass|token|secret|auth|serial|mac/i;
function pick(fields, ...keys) {
    for (const k of keys) {
        const v = fields.get(k);
        if (v !== undefined && v !== '') {
            return v;
        }
    }
    return undefined;
}
function fieldsToEvent(fields, cameraId, receivedAt, opts = {}) {
    const rawEventType = pick(fields, 'eventtype');
    if (!rawEventType) {
        throw new PayloadError('Alert has no eventType');
    }
    const { name, known } = normalizeEventType(rawEventType);
    if (!known && opts.discoverUnknown === false) {
        return null;
    }
    const stateRaw = (pick(fields, 'eventstate') ?? 'active').toLowerCase();
    const eventState = ['inactive', 'false', '0', 'stop', 'end', 'off'].includes(stateRaw) ? 'inactive' : 'active';
    const rawTarget = pick(fields, 'targettype', 'detectiontarget');
    const channel = parseInt(pick(fields, 'channelid', 'dynchannelid') ?? '1', 10);
    const post = parseInt(pick(fields, 'activepostcount') ?? '', 10);
    const cameraTimestamp = pick(fields, 'datetime');
    let timestamp;
    if (cameraTimestamp) {
        const d = new Date(cameraTimestamp);
        timestamp = Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const extra = {};
    let n = 0;
    for (const [k, v] of fields) {
        if (CONSUMED.has(k) || PRIVATE_KEY.test(k) || n >= 40) {
            continue;
        }
        extra[k] = v.slice(0, 200);
        n++;
    }
    return {
        cameraId,
        eventType: name,
        rawEventType,
        eventState,
        target: normalizeTarget(rawTarget),
        rawTarget,
        channelId: Number.isFinite(channel) && channel > 0 ? channel : 1,
        ruleId: pick(fields, 'ruleid'),
        regionId: pick(fields, 'regionid'),
        direction: pick(fields, 'direction'),
        eventId: pick(fields, 'eventid', 'uuid'),
        activePostCount: Number.isFinite(post) ? post : undefined,
        description: pick(fields, 'eventdescription'),
        timestamp,
        cameraTimestamp,
        receivedAt,
        heartbeat: name === 'video_loss' && eventState === 'inactive',
        extra,
    };
}
