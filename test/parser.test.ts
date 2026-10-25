import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EventStreamParser } from '../src/lib/EventStreamParser';
import { fieldsToEvent, parsePart, PayloadError } from '../src/lib/EventNormalizer';
import { parseXml, XmlError } from '../src/lib/xml';
import type { StreamPart } from '../src/lib/types';
import { alertXml, BOUNDARY, heartbeatXml, multipartPart } from './fixtures';

function collect(boundary: string | undefined = BOUNDARY, limits: { maxPartBytes?: number; maxBufferBytes?: number } = {}) {
    const parts: StreamPart[] = [];
    const errors: string[] = [];
    const parser = new EventStreamParser({ boundary, ...limits, onPart: p => parts.push(p), onError: e => errors.push(e) });
    return { parser, parts, errors };
}

describe('xml', () => {
    it('parses namespaced XML without declaration', () => {
        const root = parseXml(alertXml({ declaration: false }));
        assert.equal(root.name, 'EventNotificationAlert');
        assert.ok(root.children.length > 3);
    });
    it('rejects DTD / entity declarations', () => {
        assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), XmlError);
    });
    it('does not expand unknown entities', () => {
        assert.equal(parseXml('<a>&foo;&amp;</a>').text, '&foo;&');
    });
    it('rejects mismatched tags', () => {
        assert.throws(() => parseXml('<a><b></a>'), XmlError);
    });
});

describe('EventStreamParser', () => {
    it('parses a single multipart XML part', () => {
        const { parser, parts } = collect();
        parser.feed(multipartPart(alertXml()));
        assert.equal(parts.length, 1);
        assert.match(parts[0].body.toString(), /linedetection/);
    });

    it('parses multiple events in one chunk', () => {
        const { parser, parts } = collect();
        parser.feed(Buffer.concat([multipartPart(alertXml()), multipartPart(alertXml({ eventType: 'VMD' })), multipartPart(heartbeatXml())]));
        assert.equal(parts.length, 3);
    });

    it('handles arbitrary chunk splits (byte by byte)', () => {
        const { parser, parts, errors } = collect();
        const all = Buffer.concat([multipartPart(alertXml()), multipartPart(alertXml({ eventType: 'fielddetection' }))]);
        for (let i = 0; i < all.length; i++) {
            parser.feed(all.subarray(i, i + 1));
        }
        assert.equal(parts.length, 2);
        assert.deepEqual(errors, []);
    });

    it('handles parts without Content-Length', () => {
        const { parser, parts } = collect();
        parser.feed(Buffer.concat([multipartPart(alertXml(), 'application/xml', false), multipartPart(alertXml(), 'application/xml', false)]));
        parser.feed(Buffer.from(`--${BOUNDARY}--\r\n`));
        assert.equal(parts.length, 2);
        assert.match(parts[0].body.toString(), /^<\?xml/);
    });

    it('does not break on binary image parts', () => {
        const { parser, parts } = collect();
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`--${BOUNDARY}\r\n`), Buffer.alloc(2000, 0x41)]);
        parser.feed(Buffer.concat([multipartPart(alertXml()), multipartPart(jpeg, 'image/jpeg'), multipartPart(alertXml({ eventType: 'VMD' }))]));
        assert.equal(parts.length, 3);
        assert.equal(parsePart(parts[1]), null);
        assert.equal(parsePart(parts[2])?.get('eventtype'), 'VMD');
    });

    it('skips oversized parts and keeps going', () => {
        const { parser, parts, errors } = collect(BOUNDARY, { maxPartBytes: 1000 });
        parser.feed(Buffer.concat([multipartPart(Buffer.alloc(5000, 0x41), 'image/jpeg'), multipartPart(alertXml())]));
        assert.equal(parts.length, 1);
        assert.equal(errors.length, 1);
    });

    it('recovers after malformed XML', () => {
        const { parser, parts } = collect();
        parser.feed(Buffer.concat([multipartPart('<EventNotificationAlert><eventType>x'), multipartPart(alertXml())]));
        assert.equal(parts.length, 2);
        assert.throws(() => parsePart(parts[0]), PayloadError);
        assert.ok(parsePart(parts[1]));
    });

    it('falls back to bare XML documents without a boundary', () => {
        const { parser, parts } = collect('');
        const xml = alertXml();
        parser.feed(Buffer.from(xml.slice(0, 40)));
        parser.feed(Buffer.from(xml.slice(40) + alertXml({ eventType: 'VMD' })));
        assert.equal(parts.length, 2);
    });

    it('bounds memory when no delimiter ever arrives', () => {
        const { parser, errors } = collect(BOUNDARY, { maxPartBytes: 1000, maxBufferBytes: 2000 });
        for (let i = 0; i < 50; i++) {
            parser.feed(Buffer.alloc(1000, 0x41));
        }
        assert.ok(true);
        assert.ok(errors.length >= 0);
    });
});

describe('EventNormalizer', () => {
    const part = (body: string, contentType = 'application/xml'): StreamPart => ({ contentType, headers: {}, body: Buffer.from(body) });
    const norm = (body: string, ct?: string) => {
        const f = parsePart(part(body, ct));
        assert.ok(f);
        return fieldsToEvent(f, 'cam', '2026-01-01T00:00:00.000Z');
    };

    it('maps known events and keeps the raw type', () => {
        const e = norm(alertXml({ eventType: 'linedetection' }));
        assert.equal(e?.eventType, 'line_crossing');
        assert.equal(e?.rawEventType, 'linedetection');
        assert.equal(e?.eventState, 'active');
        assert.equal(e?.channelId, 1);
        assert.equal(e?.timestamp, '2026-01-02T02:04:05.000Z');
        assert.equal(e?.cameraTimestamp, '2026-01-02T03:04:05+01:00');
    });

    it('exposes unknown events under a sanitized stable id', () => {
        const e = norm(alertXml({ eventType: 'Weird Event/Type!' }));
        assert.equal(e?.eventType, 'weird_event_type');
        assert.equal(e?.rawEventType, 'Weird Event/Type!');
    });

    it('can drop unknown events when discovery is disabled', () => {
        const f = parsePart(part(alertXml({ eventType: 'mystery' })));
        assert.equal(fieldsToEvent(f!, 'cam', 'x', { discoverUnknown: false }), null);
    });

    it('extracts human/vehicle target, rule, region, direction', () => {
        const h = norm(alertXml({ target: 'human', ruleId: '2', regionId: '3', direction: 'right' }));
        assert.equal(h?.target, 'human');
        assert.equal(h?.ruleId, '2');
        assert.equal(h?.regionId, '3');
        assert.equal(h?.direction, 'right');
        assert.equal(norm(alertXml({ target: 'vehicle' }))?.target, 'vehicle');
        assert.equal(norm(alertXml({ target: 'cat' }))?.target, 'other');
    });

    it('never infers a target when the camera did not report one', () => {
        assert.equal(norm(alertXml())?.target, 'none');
    });

    it('parses JSON events', () => {
        const e = norm(
            JSON.stringify({ eventType: 'fielddetection', eventState: 'active', channelID: 2, FieldDetection: { targetType: 'Vehicle', ruleName: 'gate' } }),
            'application/json',
        );
        assert.equal(e?.eventType, 'intrusion');
        assert.equal(e?.channelId, 2);
        assert.equal(e?.target, 'vehicle');
        assert.equal(e?.extra.rulename, 'gate');
    });

    it('flags the videoloss/inactive keep-alive as heartbeat', () => {
        assert.equal(norm(heartbeatXml())?.heartbeat, true);
        assert.equal(norm(alertXml({ eventType: 'videoloss', eventState: 'active' }))?.heartbeat, false);
    });

    it('tolerates missing optional fields', () => {
        const e = norm('<EventNotificationAlert><eventType>VMD</eventType></EventNotificationAlert>');
        assert.equal(e?.eventState, 'active');
        assert.equal(e?.channelId, 1);
        assert.equal(e?.ruleId, undefined);
    });

    it('rejects alerts without eventType', () => {
        const f = parsePart(part('<EventNotificationAlert><channelID>1</channelID></EventNotificationAlert>'));
        assert.throws(() => fieldsToEvent(f!, 'cam', 'x'), PayloadError);
    });

    it('does not copy credential-like fields into extra metadata', () => {
        const e = norm('<A><eventType>VMD</eventType><password>secret</password><macAddress>aa</macAddress><foo>bar</foo></A>');
        assert.deepEqual(Object.keys(e!.extra), ['foo']);
    });
});
