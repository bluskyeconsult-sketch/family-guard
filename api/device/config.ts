// GET /api/device/config
// The child app pulls its current policy here: the Private DNS hostname to
// enforce, the launcher allowlist, screen-time and quiet hours, the
// hard-stop lock state, and which extras are on. Device token only.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../../lib/supabase';
import { authDevice } from '../../lib/device';
import { json, methodGuard } from '../../lib/respond';
import { featureOn } from '../../lib/features';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await authDevice(req);
  if (!ctx) return json(res, 401, { error: 'unauthorized' });

  const db = admin();
  const [fam, child, apps, hard, messengerOn, safetyOn, hardOn] = await Promise.all([
    db.from('guard_family_settings').select('dns_hostname').eq('family_id', ctx.family_id).maybeSingle(),
    db
      .from('guard_child_settings')
      .select('screen_time_minutes,quiet_start,quiet_end,launcher_enabled')
      .eq('learner_id', ctx.learner_id)
      .maybeSingle(),
    db.from('guard_approved_apps').select('package_name,label').eq('learner_id', ctx.learner_id),
    db.from('guard_hard_stop').select('locked,reason').eq('learner_id', ctx.learner_id).maybeSingle(),
    featureOn(ctx.family_id, 'messenger'),
    featureOn(ctx.family_id, 'safety_alerts'),
    featureOn(ctx.family_id, 'hard_stop'),
  ]);

  const locked = hardOn && hard.data ? hard.data.locked === true : false;

  json(res, 200, {
    dns_hostname: fam.data?.dns_hostname ?? 'family.cloudflare-dns.com',
    screen_time_minutes: child.data?.screen_time_minutes ?? null,
    quiet_start: child.data?.quiet_start ?? null,
    quiet_end: child.data?.quiet_end ?? null,
    launcher_enabled: child.data?.launcher_enabled ?? true,
    approved_apps: (apps.data ?? []).map((a) => ({ package: a.package_name, label: a.label })),
    hard_stop: { enabled: hardOn, locked, reason: locked ? hard.data?.reason ?? null : null },
    features: { messenger: messengerOn, safety_alerts: safetyOn, hard_stop: hardOn },
  });
}
