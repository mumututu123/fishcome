// Self-contained routing encoding, not encryption or IP anonymity.
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const DOMAIN = 'fish-invite-v1:';
function base64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unbase64(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('邀请码格式无效');
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), char => char.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error('邀请码格式无效'); return bytes;
}
function endpoint(text) {
  try { const url = new URL(text); if (url.protocol !== 'http:' || url.username || url.password || !url.port || +url.port < 1024 || +url.port > 65535 || url.hostname.length > 253) throw new Error(); return url.origin; }
  catch { throw new Error('邀请码中的接入信息无效'); }
}
async function checksum(url) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(DOMAIN + url))).slice(0, 8)); }
export async function encodeInvite(url) { const canonical = endpoint(url); return `YL1.${base64(encoder.encode(canonical))}.${await checksum(canonical)}`; }
export async function decodeInvite(value) {
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error();
    const code = value.replace(/\s/g, ''), parts = code.split('.'); if (parts.length !== 3 || parts[0] !== 'YL1') throw new Error();
    const raw = decoder.decode(unbase64(parts[1])), url = endpoint(raw);
    if (raw !== url || parts[2] !== await checksum(url)) throw new Error(); return url;
  } catch { throw new Error('邀请码无效或不完整，请重新复制'); }
}
export async function normalizeInvite(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请粘贴同事的邀请码');
  const input = value.trim();
  if (input.startsWith('YL1.')) { await decodeInvite(input); return input.replace(/\s/g, ''); }
  // Older backups and join packages contain URLs. Upgrade before persistence.
  return encodeInvite(input);
}
