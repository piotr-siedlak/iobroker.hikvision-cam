# ioBroker.hikvision-cam

Receives **real-time smart events directly from Hikvision IP cameras** (line crossing, intrusion, motion, human/vehicle classification, ...) through the ISAPI event stream and exposes them as ioBroker states. No NVR, no cloud, no Home Assistant, no polling.

> **Status: 0.2.0 – early release.** All logic is covered by automated tests against a *mock* ISAPI camera built from the publicly documented format. It has **not yet been verified against a physical camera** (initial target: `DS-2CD2387G2-LU`). See [Known limitations](#known-limitations).

## How it works

For every configured camera the adapter opens one persistent connection to

```
GET /ISAPI/Event/notification/alertStream
```

authenticates with HTTP Digest, and parses the multipart/XML (or JSON) stream as it arrives. Detection rules live in the camera; the adapter is **read-only** (HTTP GET only, never changes analytics, schedules, linkage or network settings).

Why not extend [ioBroker.hikvision-alarmserver](https://github.com/iobroker-community-adapters/ioBroker.hikvision-alarmserver)? That adapter is an HTTP *server* the camera pushes to (needs per-camera "HTTP listening" configuration, one open port, no stream-liveness information). This adapter *pulls* a persistent stream, so it can tell "no alarm" from "camera unreachable", needs no camera-side push target and no inbound port.

## Installation

From GitHub (until it is in the official repository):

1. ioBroker Admin → **Adapters** → *Install from custom URL* (cat icon) → *GitHub* tab, or run on the ioBroker host:
   ```bash
   iobroker url https://github.com/piotr-siedlak/iobroker.hikvision-cam
   ```
2. Add an instance and open its settings.

Requires Node.js ≥ 20, js-controller ≥ 5.0.19, Admin ≥ 6.17.14.

## Configuration

One table row per camera:

| Field | Meaning |
|---|---|
| Name | Becomes the object id (`cameras.<name>`), e.g. `front_gate` |
| IP address or host / Protocol / Port | Plain host or IP (no URL). HTTPS verifies the certificate unless unticked |
| User / Password | Camera user with **remote notification / alarm** permission (a read-only/operator user is enough; admin is not required) |
| Authentication | **Digest** (default, recommended). *Basic* only if explicitly selected – credentials are then sent unencrypted over HTTP |
| Alarm timeout (s) | Default 5. Clears an active alarm that is no longer refreshed (cameras that never send "inactive") |
| Reconnect interval (s) | Base of the exponential backoff (default 5 s, with jitter, max 5 min) |
| Stream inactivity timeout (s) | Default 60. If no data/heartbeat arrives for this long **after the stream has delivered data once**, the connection is dropped and re-established |
| Ignore events | Comma separated normalized or raw names, e.g. `motion,vmd` |
| Create unknown event types | Unknown event types are exposed under a sanitized id (default). Untick to drop them |
| Log raw payloads | Logs the first 50 payload heads and keeps the latest in `info.lastRawPayload` (credentials redacted) for diagnostics |

### Verify ISAPI access first

```bash
read -rs -p 'Camera password: ' CAMPASS; echo
curl --digest -N -u "admin:${CAMPASS}" 'http://CAMERA_IP/ISAPI/Event/notification/alertStream'
unset CAMPASS
```

Trigger a rule (walk through the zone). XML blocks should appear, plus a `videoloss`/`inactive` heartbeat roughly every 10–30 s. Reading the password with `read -s` keeps it out of the shell history; avoid `-u user:password` literals. To also hide it from the process list use a netrc file: `printf 'machine CAMERA_IP login admin password …\n' > ~/.netrc-cam; chmod 600 ~/.netrc-cam; curl --digest -N --netrc-file ~/.netrc-cam …`.

### Camera-side requirements

Enabling a detection rule does **not** necessarily mean the event is reported over ISAPI. In the camera's web UI, for each rule (Event → Smart Event / Basic Event) open **Arming Schedule** and **Linkage Method** and tick **Notify Surveillance Center** (a.k.a. "Notify Surveillance Center / Send to Center"). The adapter never changes this for you. If `curl` shows nothing while the rule triggers, this is the first thing to check. AcuSense human/vehicle classification must be enabled on the rule itself.

## Objects

```
hikvision-cam.0.cameras.<camera>
├── info.{connection, streamConnected, status, model, firmware, ipAddress,
│         lastSeen, lastHeartbeat, lastSuccessfulConnection, lastError, lastEvent,
│         reconnectCount, eventsReceived, parseErrors}
├── events.<event>.{active, state, valid, lastTriggered, count, lastTarget}
│        └── human.active / vehicle.active      (only created once the camera reports a classification)
│        └── rules.<ch1_r2_g3>.{active, state, count, lastTriggered, target}   (only when rule/region/channel>1 are reported)
└── lastEvent.{type, rawType, state, target, timestamp, receivedAt, channel, ruleId, regionId, direction, sequence, json}
```

Normalized event names: `motion` (VMD), `line_crossing` (linedetection), `intrusion` (fielddetection), `region_entrance`, `region_exit`, `loitering`, `face_detection`, `people_gathering`, `unattended_baggage`, `object_removal` (attendedBaggage), `scene_change`, `tampering` (shelterAlarm), `video_loss`, `defocus`, `audio_exception`, `pir`, `alarm_input` (IO), `system_exception` (diskfull, diskerror, nicbroken, ipconflict, illaccess, …). Anything else is created dynamically from the camera's own event type (sanitized, e.g. `ANPR` → `anpr`); `rawEventType` is always preserved in `lastEvent`. The mapping comes from public documentation and open-source integrations and still needs real-camera verification.

Object ids are stable across restarts and reconnects; counters continue where they stopped.

## Alarm lifecycle

`state` is tri-state: **`inactive` / `active` / `unknown`**. `active` is `true`/`false`, or `null` while `unknown`; `valid` is `false` while unknown.

* **Explicit inactive**: `eventState=inactive` → `active=false` immediately.
* **Repeated active**: retransmissions refresh the timer only (no extra trigger, no extra writes).
* **No inactive sent**: cleared after *Alarm timeout* without refresh.
* **Separate detections**: a *new trigger* (counted) is an active notice when the alarm was not active, **or** with a different event id, **or** whose `activePostCount` did not increase (counter restart). Two line crossings in quick succession therefore produce two triggers, `count` +2, and a new `lastTriggered` / `lastEvent.sequence` – even though `active` stayed `true`. For automations, trigger on `lastEvent.sequence`/`.json`/`count` (any change, written with ack) rather than on `active` flips.
* **One-shot events** appear as a counter/timestamp bump, then fall back to inactive after the timeout.
* **Stream lost**: all alarms of that camera become `unknown` (`active=null`, `valid=false`); on reconnect they become `inactive`. After an adapter restart stored values are reset to `unknown` until the stream is up. An alarm that was already running when the stream (re)connected is only noticed on the camera's next notification.
* Multiple rules/regions/channels have independent slots; the event-level `active` is true while any slot is active.
* `videoloss` + `inactive` is the camera heartbeat; it feeds `info.lastHeartbeat` and never creates objects (it does clear a real active video-loss alarm).

## Connection states (`info.status`)

`connecting`, `waiting` (HTTP stream up, nothing received yet), `receiving`, `lost: …`, `authFailed: …`, `denied: …` (HTTP 403), `unsupported: …` (HTTP 404/405/501). `info.connection` = HTTP stream established; `info.streamConnected` = data/heartbeat actually received on this session. A quiet scene is not an error.

Authentication failures are never retried quickly: one retry after 30 minutes, at most 3 attempts, then the camera is left alone until the instance is restarted (protects against account lockout).

## Troubleshooting missing events

1. `curl` test above – nothing? Check *Notify Surveillance Center*, arming schedule, rule enabled, user permission.
2. `info.status` / `info.lastError` tell why (wrong password, 403, unsupported firmware).
3. Enable **Log raw payloads** and compare with the sample from `curl`; `info.parseErrors` > 0 means payloads could not be parsed – please open an issue with a sanitized sample.
4. Some firmware limits the number of simultaneous alertStream clients (`info.status` shows *Camera busy (HTTP 503)*): close other clients (iVMS, NVR, other integrations).

## Example script (JavaScript adapter)

```js
// Notify on a human crossing the line at the front gate
on({ id: 'hikvision-cam.0.cameras.front_gate.lastEvent.sequence', change: 'any' }, () => {
    const ev = JSON.parse(getState('hikvision-cam.0.cameras.front_gate.lastEvent.json').val);
    if (ev.eventType === 'line_crossing' && ev.eventState === 'active' && ev.target === 'human') {
        sendTo('telegram.0', `Person at the gate (${ev.direction || 'direction unknown'})`);
    }
});

// Only act on trustworthy state
on({ id: 'hikvision-cam.0.cameras.front_gate.events.intrusion.active', val: true }, () => {
    if (getState('hikvision-cam.0.cameras.front_gate.events.intrusion.valid').val) {
        log('Intrusion zone active');
    }
});
```

## Known limitations

* Not verified on physical cameras yet; event name mapping and field names (`detectionTarget`/`targetType`, `ruleID`, `regionID`) are based on public documentation and may differ per firmware. Camera-reported rule/region handling takes the *first* value in a payload.
* Camera passwords are stored encrypted (Admin table `encryptedAttributes`, Admin ≥ 6.17.7). A password saved with 0.1.0 was stored in plain text: re-enter it once after updating. Still prefer a dedicated low-privilege camera user.
* Images/snapshots in the stream are skipped, not stored. No HTTP push mode, ONVIF fallback, NVR multi-channel mapping, MQTT or history yet.
* The stream-inactivity timeout is only armed after the stream delivered data once; before that, silent half-open TCP connections are detected only by TCP keep-alive.

## Changelog

### 0.2.0
* Camera passwords stored encrypted; re-enter passwords saved with 0.1.0
* Admin: tabs, camera setup guide, tooltips (en/pl)
* Fix: Digest and Basic challenges sent in one combined header were mixed up
* Clear diagnostics for HTTP 503 (stream client limit); `info.lastRawPayload` in diagnostic mode
* Alarms are left `unknown` (not stale) when the adapter stops
* Tests for the ioBroker publishing layer; lint enforced in CI

### 0.1.0
* Initial release

## Development

```bash
npm install
npm run build   # tsc → build/
npm test        # unit + mock-camera integration tests
```

CI (GitHub Actions) builds and tests on Node 20/22 and commits the compiled `build/` to `main` so the adapter can be installed straight from GitHub.

## License

MIT © 2026 Piotr Siedlak
