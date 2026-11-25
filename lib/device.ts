// Turns the device token in the request header into the device context.
// The child phone sends header x-device-token on every request. The token
// itself is never stored anywhere: guard_device_from_token hashes it and
// matches the hash. A missing or unknown token yields null (the caller
// then returns 401). Children have no Supabase account; this is their only
// way in, and it reaches only their own learner rows.
import type { VercelRequest } from '@vercel/node';
import { admin } from './supabase';

// Minimum accepted token length. Lowered 32 -> 12 to accept the shorter
// 16-character enrolment codes while still rejecting junk.
const MIN_TOKEN_LEN = 12;

export interface DeviceContext {
  device_id: string;
  learner_id: string;
  family_id: string;
  device_owner: boolean;
}

export function deviceToken(req: VercelRequest): string | null {
  const h = req.headers['x-device-token'];
  if (typeof h === 'string' && h.length >= MIN_TOKEN_LEN) return h;
  if (Array.isArray(h) && typeof h[0] === 'string' && h[0].length >= MIN_TOKEN_LEN) return h[0];
  return null;
}

export async function authDevice(req: VercelRequest): Promise<DeviceContext | null> {
  const token = deviceToken(req);
  if (!token) return null;
  const { data, error } = await admin().rpc('guard_device_from_token', { p_token: token });
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as DeviceContext;
  if (!row.device_id || !row.learner_id || !row.family_id) return null;
  return {
    device_id: row.device_id,
    learner_id: row.learner_id,
    family_id: row.family_id,
    device_owner: row.device_owner === true,
  };
}
