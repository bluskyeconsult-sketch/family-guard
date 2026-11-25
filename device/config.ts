// GET /api/device/config
// The child app pulls its current policy here: the Private DNS hostname to
// enforce, the launcher allowlist, screen-time and quiet hours, the
// hard-stop lock state, which extras are on, the Learn-first gate, and the
// Family Tutor web app settings. Device token only.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../../lib/supabase';
import { authDevice } from '../../lib/device';
import { json, methodGuard } from '../../lib/respond';
import { featureOn } from '../../lib/features';

const LEARN_FIRST_MESSAGE = "Finish today's lesson in Family Tutor to unlock this.";
const DEFAULT_TUTOR_URL = 'https://learn.bluskyeconsult.com';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await authDevice(req);
  if (!ctx) return json(res, 401, { error: 'unauthorized' });

  const db = admin();
  const [fam, child, apps, hard, messengerOn, safetyOn, hardOn] = await Promise.all([
    db
      .from('guard_family_settings')
      .select('dns_hostname,learn_first_url,tutor_camera')
      .eq('family_id', ctx.family_id)
      .maybeSingle(),
    db
      .from('guard_child_settings')
      .select('screen_time_minutes,quiet_start,quiet_end,launcher_enabled,learn_first,learn_first_unlock_on')
      .eq('learner_id', ctx.learner_id)
      .maybeSingle(),
    db.from('guard_approved_apps').select('package_name,label').eq('learner_id', ctx.learner_id),
    db.from('guard_hard_stop').select('locked,reason').eq('learner_id', ctx.learner_id).maybeSingle(),
    featureOn(ctx.family_id, 'messenger'),
    featureOn(ctx.family_id, 'safety_alerts'),
    featureOn(ctx.family_id, 'hard_stop'),
  ]);

  const hardLocked = hardOn && hard.data ? hard.data.locked === true : false;

  // ---- Learn first gate ------------------------------------------------
  // When on, ALL approved apps are locked until the child completes a lesson
  // today (or a parent grants a one-off unlock). Family Tutor is not an
  // approved app — it is the always-available WebView tile — so it is never
  // gated here. If the learning check errors, we fail OPEN so a backend
  // glitch never traps the child.
  const learnFirstOn = child.data?.learn_first === true;
  let learnFirstLocked = false;

  if (learnFirstOn) {
    const todayLondon = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const unlockedToday = child.data?.learn_first_unlock_on === todayLondon;
    if (!unlockedToday) {
      let lessons = 0;
      try {
        const lt = await db.rpc('learning_today', { p_learner_id: ctx.learner_id, p_tz: 'Europe/London' });
        if (lt.error) {
          lessons = 1; // fail open
        } else {
          const row = Array.isArray(lt.data) ? lt.data[0] : lt.data;
          lessons = Number((row as { lessons_completed?: number } | null)?.lessons_completed ?? 0);
        }
      } catch {
        lessons = 1; // fail open
      }
      learnFirstLocked = lessons < 1;
    }
  }

  const approved = (apps.data ?? []).map((a) => ({
    package: a.package_name,
    label: a.label,
    locked: learnFirstLocked,
  }));

  json(res, 200, {
    dns_hostname: fam.data?.dns_hostname ?? 'family.cloudflare-dns.com',
    screen_time_minutes: child.data?.screen_time_minutes ?? null,
    quiet_start: child.data?.quiet_start ?? null,
    quiet_end: child.data?.quiet_end ?? null,
    launcher_enabled: child.data?.launcher_enabled ?? true,
    approved_apps: approved,
    hard_stop: { enabled: hardOn, locked: hardLocked, reason: hardLocked ? hard.data?.reason ?? null : null },
    features: { messenger: messengerOn, safety_alerts: safetyOn, hard_stop: hardOn },
    learn_first: { on: learnFirstOn, locked: learnFirstLocked, message: LEARN_FIRST_MESSAGE },
    tutor: {
      url: fam.data?.learn_first_url ?? DEFAULT_TUTOR_URL,
      camera: fam.data?.tutor_camera !== false,
    },
  });
}
