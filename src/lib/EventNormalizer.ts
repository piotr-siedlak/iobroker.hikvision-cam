import { flattenJson, flattenXml, parseXml } from './xml';
import type { HikvisionEvent, StreamPart, Target } from './types';
import { sanitizeId } from './util';

export class PayloadError extends Error {}

/**
 * Raw ISAPI event type (lower-case) -> normalized ioBroker name.
 * Derived from public ISAPI documentation and open-source integrations;
 * not yet verified against every camera model/firmware.
 */
export const EVENT_MAP: Readonly<Record<string, string>> = {
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

export function normalizeEventType(raw: string): { name: string; known: boolean } {
    const mapped = EVENT_MAP[raw.toLowerCase()];
    return mapped ? { name: mapped, known: true } : { name: sanitizeId(raw), known: false };
}

export function normalizeTarget(raw: string | undefined): Target {
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
export function parsePart(part: StreamPart): Map<string, string> | null {
    const ct = part.contentType.toLowerCase();
    if (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/')) {
        return null;
    }
    const text = part.body.toString('utf8').trimStart();
    const fields = new Map<string, string>();
    try {
        if (text.startsWith('<')) {
            flattenXml(parseXml(text), fields);
            return fields;
        }
        if (text.startsWith('{') || text.startsWith('[')) {
            flattenJson(JSON.parse(text), fields);
            return fields;
        }
    } catch (err) {
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

function pick(fields: Map<string, string>, ...keys: string[]): string | undefined {
    for (const k of keys) {
        const v = fields.get(k);
        if (v !== undefined && v !== '') {
            return v;
        }
    }
    return undefined;
}

export interface NormalizeOptions {
    /** When false, event types missing from EVENT_MAP are rejected. Default true. */
    discoverUnknown?: boolean;
}

export function fieldsToEvent(
    fields: Map<string, string>,
    cameraId: string,
    receivedAt: string,
    opts: NormalizeOptions = {},
): HikvisionEvent | null {
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
    let timestamp: string | undefined;
    if (cameraTimestamp) {
        const d = new Date(cameraTimestamp);
        timestamp = Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }

    const extra: Record<string, string> = {};
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
