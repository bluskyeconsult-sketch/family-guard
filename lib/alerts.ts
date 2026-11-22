import { admin } from './supabase';
import type { DeviceContext } from './device';
import { haversineMeters } from './geofence';

export type Severity = 'info' | 'warn' | 'high';

export async function raiseAlert(
  ctx: DeviceContext,
  kind: string,
  severity: Severity,
  title: string,
  body: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  await admin()
    .from('guard_alerts')
    .insert({
      family_id: ctx.family_id,
      learner_id: ctx.learner_id,
      device_id: ctx.device_id,
      kind,
      severity,
      title,
      body,
      data,
    });
}

interface PlaceRow {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radius_m: number;
  notify_enter: boolean;
  notify_exit: boolean;
}

// Compares the newest location against every family place, maintains the
// inside/outside state per device per place, and raises an enter or exit
// alert on a real transition only. The first time a device is seen at a
// place it sets the baseline silently, so a restart does not fire a false
// arrival.
export async function runGeofence(
  ctx: DeviceContext,
  lat: number,
  lng: number,
): Promise<void> {
  const db = admin();
  const places = await db
    .from('guard_places')
    .select('id,label,lat,lng,radius_m,notify_enter,notify_exit')
    .eq('family_id', ctx.family_id);
  if (places.error || !Array.isArray(places.data) || places.data.length === 0) return;

  const states = await db
    .from('guard_place_state')
    .select('place_id,inside')
    .eq('device_id', ctx.device_id);
  const was = new Map<string, boolean>();
  for (const s of states.data ?? []) was.set(s.place_id as string, s.inside as boolean);

  const now = new Date().toISOString();
  for (const p of places.data as PlaceRow[]) {
    const inside = haversineMeters(lat, lng, p.lat, p.lng) <= p.radius_m;
    const prev = was.get(p.id);
    if (prev === undefined) {
      await db
        .from('guard_place_state')
        .upsert(
          { device_id: ctx.device_id, place_id: p.id, inside, changed_at: now },
          { onConflict: 'device_id,place_id' },
        );
      continue;
    }
    if (inside === prev) continue;
    await db
      .from('guard_place_state')
      .upsert(
        { device_id: ctx.device_id, place_id: p.id, inside, changed_at: now },
        { onConflict: 'device_id,place_id' },
      );
    if (inside && p.notify_enter) {
      await raiseAlert(ctx, 'geofence_enter', 'info', `Arrived at ${p.label}`, null, {
        place_id: p.id,
      });
    }
    if (!inside && p.notify_exit) {
      await raiseAlert(ctx, 'geofence_exit', 'info', `Left ${p.label}`, null, {
        place_id: p.id,
      });
    }
  }
}
