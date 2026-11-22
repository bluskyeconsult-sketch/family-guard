// /api/device/messages  (child messenger; text only)
//   GET                      -> list the child threads
//   GET ?thread_id=&before=  -> a page of messages in a thread (newest first)
//   POST { thread_id, body } -> send a text message
// Every call goes through the guard_child_* security-definer functions,
// which prove the child is a member of the thread. Device token only, and
// only works when the messenger extra is on for the family.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../../lib/supabase';
import { authDevice } from '../../lib/device';
import { json, methodGuard, parseBody } from '../../lib/respond';
import { featureOn } from '../../lib/features';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await authDevice(req);
  if (!ctx) return json(res, 401, { error: 'unauthorized' });

  if (!(await featureOn(ctx.family_id, 'messenger'))) {
    return json(res, 403, { error: 'messenger_disabled' });
  }

  const db = admin();

  if (req.method === 'GET') {
    const threadId = typeof req.query.thread_id === 'string' ? req.query.thread_id : null;
    if (!threadId) {
      const r = await db.rpc('guard_child_threads', { p_learner_id: ctx.learner_id });
      if (r.error) return json(res, 400, { error: r.error.message });
      return json(res, 200, { threads: r.data ?? [] });
    }
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const r = await db.rpc('guard_child_fetch_messages', {
      p_learner_id: ctx.learner_id,
      p_thread_id: threadId,
      p_before: before,
      p_limit: 50,
    });
    if (r.error) return json(res, 403, { error: r.error.message });
    return json(res, 200, { messages: r.data ?? [] });
  }

  // POST
  const body = parseBody(req.body);
  const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
  const text = typeof body.body === 'string' ? body.body : null;
  if (!threadId || !text || text.trim().length === 0) {
    return json(res, 400, { error: 'thread_id and body are required' });
  }
  const r = await db.rpc('guard_child_send_message', {
    p_learner_id: ctx.learner_id,
    p_thread_id: threadId,
    p_body: text.slice(0, 4000),
  });
  if (r.error) return json(res, 403, { error: r.error.message });
  return json(res, 200, { id: r.data });
}
