// SYNTHETIC test data modelled on the publicly documented ISAPI EventNotificationAlert format.
// Not captured from a real camera.

export interface AlertOpts {
    eventType?: string;
    eventState?: string;
    channel?: number;
    dateTime?: string;
    post?: number;
    ruleId?: string;
    regionId?: string;
    target?: string;
    direction?: string;
    description?: string;
    declaration?: boolean;
    namespaced?: boolean;
}

export function alertXml(o: AlertOpts = {}): string {
    const ns = o.namespaced === false ? '' : ' version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"';
    const region =
        o.ruleId !== undefined || o.regionId !== undefined || o.target !== undefined
            ? `<DetectionRegionList><DetectionRegionEntry>${o.regionId !== undefined ? `<regionID>${o.regionId}</regionID>` : ''}${
                  o.target !== undefined ? `<detectionTarget>${o.target}</detectionTarget>` : ''
              }</DetectionRegionEntry></DetectionRegionList>`
            : '';
    return (
        (o.declaration === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>\r\n') +
        `<EventNotificationAlert${ns}>` +
        `<ipAddress>192.0.2.10</ipAddress><channelID>${o.channel ?? 1}</channelID>` +
        `<dateTime>${o.dateTime ?? '2026-01-02T03:04:05+01:00'}</dateTime>` +
        `<activePostCount>${o.post ?? 1}</activePostCount>` +
        `<eventType>${o.eventType ?? 'linedetection'}</eventType>` +
        `<eventState>${o.eventState ?? 'active'}</eventState>` +
        `<eventDescription>${o.description ?? 'line detection alarm'}</eventDescription>` +
        (o.ruleId !== undefined ? `<ruleID>${o.ruleId}</ruleID>` : '') +
        (o.direction !== undefined ? `<direction>${o.direction}</direction>` : '') +
        region +
        '</EventNotificationAlert>'
    );
}

export const BOUNDARY = 'boundary';

export function multipartPart(body: string | Buffer, contentType = 'application/xml; charset="UTF-8"', withLength = true): Buffer {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const head =
        `--${BOUNDARY}\r\nContent-Type: ${contentType}\r\n` + (withLength ? `Content-Length: ${data.length}\r\n` : '') + '\r\n';
    return Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from('\r\n', 'latin1')]);
}

export function heartbeatXml(channel = 1): string {
    return alertXml({ eventType: 'videoloss', eventState: 'inactive', channel, description: 'videoloss alarm' });
}
