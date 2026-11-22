// POST /api/device/ingest
// One batched upload from the child phone. Any of these keys may be present:
//   locations[]  -> stored; geofence enter/exit computed on the newest point
//   status       -> upserted; DNS-changed, VPN-detected and low-battery alerts
//   usage[]      -> upserted as daily minutes per app
//   alerts[]     -> a restricted set the device may raise (screen time, boot,
//                   uninstall attempt, message flag); message flags only when
//                   the safety_alerts extra is on.
// Device token only. The child never reaches the database directly.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../../lib/supabase';
import { authDevice } from '../../lib/device';
import { json, methodGuard, parseBody, bool, clampBattery } from '../../lib/respond';
import { featureOn } from '../../lib/features';
import { raiseAlert, runGeofence } from '../../lib/alerts';

interface LocIn {
  lat: number;
  lng: number;
  accuracy_m?: number;
  speed_mps?: number;
  battery?: number;
  captured_at: string;
}
interface UsageIn {
  usage_day: string;
  package_name: string;
  label?: string;
  minutes: number;
}
interface StatusIn {
  battery?: number;
  charging?: boolean;
  screen_on?: boolean;
  dns_private_host?: string;
  dns_ok?: boolean;
  vpn_active?: boolean;
  app_version?: string;
  os_version?: string;
  last_boot_at?: string;
}
interface AlertIn {
  kind: string;
  severity?: 'info' | 'warn' | 'high';
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

// Only these alert kinds may be raised by the device itself. Everything
// else (geofence, DNS, VPN, battery) is derived on the server.
const DEVICE_ALERT_KINDS = new Set([
  'screen_time_reached',
  'hard_stop_ack',
  'message_flag',
  'boot',
  'uninstall_attempt',
]);

function validLoc(l: unknown): l is LocIn {
  const o = l as LocIn;
  return (
    !!o &&
    typeof o.lat === 'number' &&
    typeof o.lng === 'number' &&
    typeof o.captured_at === 'string' &&
    Math.abs(o.lat) <= 90 &&
    Math.abs(o.lng) <= 180
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await authDevice(req);
  if (!ctx) return json(res, 401, { error: 'unauthorized' });

  const db = admin();
  const body = parseBody(req.body);
  const out: Record<string, unknown> = { ok: true };

  // 1. Locations + geofence on the newest point.
  const locInput = Array.isArray(body.locations) ? (body.locations as unknown[]).slice(0, 200) : [];
  const locRows = locInput.filter(validLoc).map((l) => ({
    device_id: ctx.device_id,
    learner_id: ctx.learner_id,
    family_id: ctx.family_id,
    lat: l.lat,
    lng: l.lng,
    accuracy_m: typeof l.accuracy_m === 'number' ? l.accuracy_m : null,
    speed_mps: typeof l.speed_mps === 'number' ? l.speed_mps : null,
    battery: clampBattery(l.battery),
    captured_at: l.captured_at,
  }));
  if (locRows.length) {
    const r = await db.from('guard_locations').insert(locRows);
    if (r.error) out.locations_error = r.error.message;
    out.locations_in = locRows.length;
    let newest = locRows[0];
    for (const row of locRows) if (row.captured_at >= newest.captured_at) newest = row;
    await runGeofence(ctx, newest.lat, newest.lng);
  }

  // 2. Status + derived alerts (only on a change, to avoid repeats).
  if (body.status && typeof body.status === 'object') {
    const s = body.status as StatusIn;
    const prev = await db
      .from('guard_device_status')
      .select('dns_ok,vpn_active,dns_private_host')
      .eq('device_id', ctx.device_id)
      .maybeSingle();

    await db.from('guard_device_status').upsert(
      {
        device_id: ctx.device_id,
        learner_id: ctx.learner_id,
        family_id: ctx.family_id,
        battery: clampBattery(s.battery),
        charging: bool(s.charging),
        screen_on: bool(s.screen_on),
        dns_private_host: typeof s.dns_private_host === 'string' ? s.dns_private_host : null,
        dns_ok: bool(s.dns_ok),
        vpn_active: bool(s.vpn_active),
        app_version: typeof s.app_version === 'string' ? s.app_version : null,
        os_version: typeof s.os_version === 'string' ? s.os_version : null,
        last_boot_at: typeof s.last_boot_at === 'string' ? s.last_boot_at : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'device_id' },
    );
    out.status_in = true;

    const fam = await db
      .from('guard_family_settings')
      .select('dns_hostname')
      .eq('family_id', ctx.family_id)
      .maybeSingle();
    const expected = fam.data?.dns_hostname ?? 'family.cloudflare-dns.com';

    const dnsBadNow =
      s.dns_ok === false ||
      (typeof s.dns_private_host === 'string' && s.dns_private_host !== expected);
    const dnsBadBefore = prev.data
      ? prev.data.dns_ok === false ||
        (typeof prev.data.dns_private_host === 'string' &&
          prev.data.dns_private_host !== expected)
      : false;
    if (dnsBadNow && !dnsBadBefore) {
      await raiseAlert(
        ctx,
        'dns_changed',
        'warn',
        'Private DNS changed',
        'The content filter DNS is not the family setting.',
        { reported: s.dns_private_host ?? null, expected },
      );
    }

    if (s.vpn_active === true && prev.data?.vpn_active !== true) {
      await raiseAlert(
        ctx,
        'vpn_detected',
        'warn',
        'VPN or proxy detected',
        'A VPN or proxy is active on the device.',
        {},
      );
    }

    if (typeof s.battery === 'number' && s.battery <= 15) {
      await raiseAlert(ctx, 'low_battery', 'info', 'Low battery', 'Device battery is low.', {
        battery: s.battery,
      });
    }
  }

  // 3. App usage, as daily minutes per app.
  const usageInput = Array.isArray(body.usage) ? (body.usage as unknown[]).slice(0, 500) : [];
  const usageRows = usageInput
    .map((u) => u as UsageIn)
    .filter((u) => u && typeof u.usage_day === 'string' && typeof u.package_name === 'string')
    .map((u) => ({
      device_id: ctx.device_id,
      learner_id: ctx.learner_id,
      family_id: ctx.family_id,
      usage_day: u.usage_day,
      package_name: u.package_name,
      label: typeof u.label === 'string' ? u.label : null,
      minutes: Math.max(0, Math.min(1440, Math.round(Number(u.minutes) || 0))),
      updated_at: new Date().toISOString(),
    }));
  if (usageRows.length) {
    const r = await db
      .from('guard_app_usage')
      .upsert(usageRows, { onConflict: 'device_id,usage_day,package_name' });
    if (r.error) out.usage_error = r.error.message;
    out.usage_in = usageRows.length;
  }

  // 4. Device-raised alerts (restricted set; message flags gated).
  const alertInput = Array.isArray(body.alerts) ? (body.alerts as unknown[]).slice(0, 50) : [];
  if (alertInput.length) {
    const safety = await featureOn(ctx.family_id, 'safety_alerts');
    let n = 0;
    for (const raw of alertInput) {
      const a = raw as AlertIn;
      if (!a || !DEVICE_ALERT_KINDS.has(a.kind)) continue;
      if (a.kind === 'message_flag' && !safety) continue;
      const sev: 'info' | 'warn' | 'high' =
        a.severity === 'warn' || a.severity === 'high' ? a.severity : 'info';
      await raiseAlert(
        ctx,
        a.kind,
        sev,
        String(a.title ?? 'Alert').slice(0, 200),
        a.body ? String(a.body).slice(0, 1000) : null,
        a.data && typeof a.data === 'object' ? a.data : {},
      );
      n += 1;
    }
    out.alerts_in = n;
  }

  json(res, 200, out);
}
