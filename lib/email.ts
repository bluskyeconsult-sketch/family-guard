// Optional weekly-digest email through Brevo. This is entirely optional:
// if BREVO_API_KEY or DIGEST_FROM is not set in Vercel, it does nothing and
// the digest still lives in the database for the parent app to show. No key
// or address is ever hard-coded here.
interface DigestEmail {
  to: string[];
  subject: string;
  text: string;
}

export async function sendDigestEmail(msg: DigestEmail): Promise<boolean> {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.DIGEST_FROM;
  if (!key || !from || msg.to.length === 0) return false;
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': key,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: from, name: 'Family Guard' },
        to: msg.to.map((e) => ({ email: e })),
        subject: msg.subject,
        textContent: msg.text,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
