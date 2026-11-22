import type { VercelRequest, VercelResponse } from '@vercel/node';

export function json(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify(body));
}

export function methodGuard(
  req: VercelRequest,
  res: VercelResponse,
  allowed: string[],
): boolean {
  if (!req.method || !allowed.includes(req.method)) {
    json(res, 405, { error: 'method_not_allowed', allowed });
    return false;
  }
  return true;
}

// Vercel parses JSON bodies, but be defensive if a raw string arrives.
export function parseBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  if (typeof body === 'string' && body.length) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* ignore malformed body */
    }
  }
  return {};
}

export function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  return null;
}

export function clampBattery(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}
