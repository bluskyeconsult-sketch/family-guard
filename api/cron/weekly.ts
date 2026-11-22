// GET /api/cron/weekly  (run by Vercel Cron, once a week)
// 1. Cleans up location rows older than 30 days (backstop for pg_cron).
// 2. Rebuilds the last 8 daily summaries.
// 3. Builds the weekly digest for last week for every family.
// 4. Optionally emails each family parents, if Brevo is configured.
// Protected by CRON_SECRET: the request must carry it either as
// Authorization: Bearer <CRON_SECRET> (what Vercel Cron sends) or as the
// x-cron-secret header.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../../lib/supabase';
import { json } from '../../lib/respond';
import { sendDigestEmail } from '../../lib/email';

function authorised(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${secret}`) return true;
  const header = req.headers['x-cron-secret'];
  if (typeof header === 'string' && header === secret) return true;
  return false;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Monday (UTC) of the week before the given date.
function lastMonday(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay(); // 0 Sun .. 6 Sat
  const sinceMonday = (dow + 6) % 7;
  x.setUTCDate(x.getUTCDate() - sinceMonday - 7);
  return isoDay(x);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!authorised(req)) return json(res, 401, { error: 'unauthorized' });

  const db = admin();
  const today = new Date();

  const cleanup = await db.rpc('guard_cleanup_locations');

  const built: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const r = await db.rpc('guard_rebuild_daily_summaries', { p_day: isoDay(d) });
    built.push(typeof r.data === 'number' ? r.data : 0);
  }

  const weekStart = lastMonday(today);
  const dig = await db.rpc('guard_build_weekly_digest', { p_week_start: weekStart });

  // Optional email per family (no-op unless Brevo env is set).
  let emailed = 0;
  const digests = await db
    .from('guard_weekly_digest')
    .select('family_id,data')
    .eq('week_start', weekStart);
  for (const row of digests.data ?? []) {
    const recips = await db.rpc('guard_family_parent_emails', { p_family_id: row.family_id });
    const to = (recips.data ?? []).map((r: { email: string }) => r.email).filter(Boolean);
    if (to.length === 0) continue;
    const mins = Number((row.data as Record<string, unknown>)?.total_screen_minutes ?? 0);
    const alerts = Number((row.data as Record<string, unknown>)?.total_alerts ?? 0);
    const hours = Math.round((mins / 60) * 10) / 10;
    const ok = await sendDigestEmail({
      to,
      subject: 'Your weekly Family Guard summary',
      text:
        `Week beginning ${weekStart}.\n` +
        `Total screen time across the children: ${hours} hours.\n` +
        `Alerts this week: ${alerts}.\n` +
        `Open Family Guard for the full picture.`,
    });
    if (ok) emailed += 1;
  }

  json(res, 200, {
    ok: true,
    locations_cleaned: typeof cleanup.data === 'number' ? cleanup.data : 0,
    summaries_built: built,
    digest_families: typeof dig.data === 'number' ? dig.data : 0,
    week_start: weekStart,
    emailed,
  });
}
