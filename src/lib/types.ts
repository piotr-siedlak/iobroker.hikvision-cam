export type AlarmState = 'active' | 'inactive' | 'unknown';
export type Target = 'human' | 'vehicle' | 'other' | 'none';

/** Normalized event record produced from one ISAPI alert. */
export interface HikvisionEvent {
    cameraId: string;
    /** Normalized (ioBroker) event name, e.g. `line_crossing`. */
    eventType: string;
    /** Event type exactly as sent by the camera, e.g. `linedetection`. */
    rawEventType: string;
    eventState: 'active' | 'inactive';
    /** Only set when the camera reports a classification; never inferred. */
    target: Target;
    rawTarget?: string;
    channelId: number;
    ruleId?: string;
    regionId?: string;
    direction?: string;
    eventId?: string;
    activePostCount?: number;
    description?: string;
    /** Camera timestamp normalized to ISO-8601 (UTC) when parseable. */
    timestamp?: string;
    /** Camera timestamp exactly as received. */
    cameraTimestamp?: string;
    receivedAt: string;
    /** True for the keep-alive `videoloss`/`inactive` notification. */
    heartbeat: boolean;
    /** Additional (non-sensitive, size-limited) metadata sent by the camera. */
    extra: Record<string, string>;
}

export interface StreamPart {
    contentType: string;
    headers: Record<string, string>;
    body: Buffer;
}
