import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from '../lib/respond';

// Simple liveness check. Does not touch the database or reveal anything.
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  json(res, 200, { ok: true, service: 'family-guard-api', time: new Date().toISOString() });
}
