import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTS, DATA_DIR, DATA_FROM, MIN_FREE_DISK_GB, PUBLIC_URL, ensureDirs, userDir } from './config.ts';
import type {
  CreatorLogEntry,
  CreatorRecord,
  FeedbackItem,
  JobRecord,
  NoticeItem,
  PostItem,
  SocialAccount,
  UploadSession,
  UsageEntry,
  UserRecord,
  UserSettings,
} from './types.ts';

ensureDirs();

export const BOOT = (Math.floor(Date.now() / 1000) % 100000).toString(16);
export const SESSION_COOKIE = 'peakcut_session';

export const PLATFORM_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

const APP_FOR: Record<string, string> = {
  youtube: 'google',
  instagram: 'instagram',
  tiktok: 'tiktok',
};

const APPS_META: Record<string, [string, string, string, string]> = {
  google: ['Client ID', 'Client secret', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  instagram: ['App ID', 'App secret', 'PEAKCUT_IG_APP_ID', 'PEAKCUT_IG_APP_SECRET'],
  tiktok: ['Client key', 'Client secret', 'PEAKCUT_TIKTOK_CLIENT_KEY', 'PEAKCUT_TIKTOK_CLIENT_SECRET'],
};

export const SETTING_DEFAULTS: UserSettings = {
  discord_webhook: '',
  telegram_token: '',
  telegram_chat: '',
  paused: false,
  digest_hour: 8,
  last_digest: '',
  tour_done: false,
};

const SECRET_KEYS = new Set(['discord_webhook', 'telegram_token']);

export const CREATOR_DEFAULTS: Omit<CreatorRecord, 'id' | 'user' | 'created'> = {
  name: '',
  channel: '',
  channels: {},
  style: 'bounce',
  layout: 'blur',
  captions: true,
  min_len: 15,
  max_len: 60,
  max_clips: 6,
  min_score: 80,
  auto_watch: false,
  buffer_min: 20,
  live_per_hour: 4,
  ai_every_min: 3,
  ai_only_on_spike: true,
  auto_jump_pct: 60,
  plan: 'free',
  decide_mode: 'both',
  must_clip_min: 0,
  min_gap_min: 2,
  game: '',
  trigger_words: 'clip that, clip it',
  autopost: false,
  accounts: [],
  post_min_score: 75,
  post_gap_min: 45,
  daily_cap: 6,
  privacy: 'public',
  post_footer: '',
  rate_per_1k: 0.0,
};

const CREATOR_NUMERIC: Record<string, [number, number]> = {
  min_len: [5, 120],
  max_len: [10, 180],
  max_clips: [1, 20],
  min_score: [0, 100],
  buffer_min: [5, 120],
  live_per_hour: [1, 60],
  ai_every_min: [1, 30],
  auto_jump_pct: [20, 300],
  must_clip_min: [0, 240],
  min_gap_min: [0, 60],
  post_min_score: [0, 100],
  post_gap_min: [5, 1440],
  daily_cap: [1, 50],
};

export const PLATFORMS = ['youtube', 'twitch', 'kick'] as const;

// In-memory state (persists across requests in running process; files written to DATA_DIR)
const users = new Map<string, UserRecord>();
const sessions = new Map<string, { user_id: string; expires_at: number }>();
const versions = new Map<string, number>();
const jobs = new Map<string, JobRecord>();
const creators = new Map<string, Map<string, CreatorRecord>>();
const creatorLogs = new Map<string, CreatorLogEntry[]>();
const settingsByUser = new Map<string, UserSettings>();
const accountsByUser = new Map<string, SocialAccount[]>();
const postsByUser = new Map<string, PostItem[]>();
const usageRows: UsageEntry[] = [];
const notices: NoticeItem[] = [];
const feedbackItems: FeedbackItem[] = [];
const adminLog: { t: number; admin: string; action: string; target: string; detail: string }[] = [];
const uploads = new Map<string, UploadSession>();
const savedApps: Record<string, { id: string; secret: string }> = {};
const rateWindows = new Map<string, number[]>();

let nextNoticeId = 1;
let nextFeedbackId = 1;

export function nowSec(): number {
  return Date.now() / 1000;
}

export function dayKey(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const got = crypto.scryptSync(password, parts[1], 32);
    const expected = Buffer.from(parts[2], 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export function localUser(): UserRecord {
  let u = users.get('local');
  if (!u) {
    u = {
      id: 'local',
      email: 'owner@local',
      name: 'Owner',
      password_hash: '',
      google_sub: '',
      is_admin: true,
      disabled: false,
      verified: true,
      created_at: nowSec(),
      last_seen: nowSec(),
    };
    users.set(u.id, u);
  }
  return u;
}

export function publicUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email.split('@')[0],
    is_admin: u.is_admin,
    role: u.is_admin ? 'admin' : 'user',
    has_password: Boolean(u.password_hash),
    google: Boolean(u.google_sub),
    created_at: u.created_at,
    verified: u.verified,
    photo: 0,
  };
}

export function signupUser(email: string, password: string, name: string): UserRecord {
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    throw new Error('Enter a valid email address.');
  }
  if (password.length < 8) {
    throw new Error('Use a password of at least 8 characters.');
  }
  for (const existing of users.values()) {
    if (existing.email.toLowerCase() === cleanEmail) {
      throw new Error('An account with that email already exists.');
    }
  }
  const isFirst = users.size === 0 || (users.size === 1 && users.has('local'));
  const u: UserRecord = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    email: cleanEmail,
    name: (name || '').trim().slice(0, 80) || cleanEmail.split('@')[0],
    password_hash: hashPassword(password),
    google_sub: '',
    is_admin: isFirst,
    disabled: false,
    verified: true,
    created_at: nowSec(),
    last_seen: nowSec(),
  };
  users.set(u.id, u);
  return u;
}

export function loginUser(email: string, password: string): UserRecord {
  const cleanEmail = email.trim().toLowerCase();
  for (const u of users.values()) {
    if (u.email.toLowerCase() === cleanEmail) {
      if (u.disabled) throw new Error('This account has been disabled.');
      if (!verifyPassword(password, u.password_hash)) {
        throw new Error('Wrong email or password.');
      }
      u.last_seen = nowSec();
      return u;
    }
  }
  throw new Error('Wrong email or password.');
}

export function createSession(uid: string): string {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user_id: uid, expires_at: nowSec() + 30 * 86400 });
  return token;
}

export function userForSession(token?: string): UserRecord | null {
  if (!ACCOUNTS) return localUser();
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expires_at < nowSec()) {
    if (s) sessions.delete(token);
    return null;
  }
  const u = users.get(s.user_id) || null;
  if (!u || u.disabled) return null;
  u.last_seen = nowSec();
  return u;
}

export function endSession(token?: string): void {
  if (token) sessions.delete(token);
}

export function changeUserPassword(uid: string, currentPw: string, newPw: string): void {
  const u = users.get(uid);
  if (!u) throw new Error('Account not found.');
  if (u.password_hash && !verifyPassword(currentPw, u.password_hash)) {
    throw new Error('Current password is wrong.');
  }
  if (newPw.length < 8) {
    throw new Error('Use a password of at least 8 characters.');
  }
  u.password_hash = hashPassword(newPw);
}

export function getVersion(uid: string): number {
  return versions.get(uid) || 1;
}

export function bump(uid?: string | null): void {
  const id = uid || 'local';
  versions.set(id, (versions.get(id) || 1) + 1);
}

export function throttle(key: string, limit: number, windowSec: number): boolean {
  const now = nowSec();
  const list = (rateWindows.get(key) || []).filter((t) => t > now - windowSec);
  if (list.length >= limit) {
    rateWindows.set(key, list);
    return false;
  }
  list.push(now);
  rateWindows.set(key, list);
  return true;
}

// ------------------------------------------------------------------ Jobs
export function allJobs(): JobRecord[] {
  return Array.from(jobs.values()).sort((a, b) => b.created - a.created);
}

export function listUserJobs(uid: string): JobRecord[] {
  return allJobs().filter((j) => j.user === uid);
}

export function getJob(uid: string, jid: string): JobRecord | null {
  const j = jobs.get(jid);
  return j && j.user === uid ? j : null;
}

export function getJobAny(jid: string): JobRecord | null {
  return jobs.get(jid) || null;
}

export function putJob(job: JobRecord): void {
  jobs.set(job.id, job);
  try {
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(job, null, 1), 'utf-8');
  } catch {
    // non-fatal on ephemeral disk
  }
  bump(job.user);
}

export function removeJob(uid: string, jid: string): boolean {
  const j = jobs.get(jid);
  if (!j || j.user !== uid) return false;
  jobs.delete(jid);
  try {
    fs.rmSync(j.dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  bump(uid);
  return true;
}

export function busyJobsCount(uid: string): number {
  return listUserJobs(uid).filter((j) => j.status === 'queued' || j.status === 'running').length;
}

// ------------------------------------------------------------------ Creators
export function platformKey(url: string): string {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    const h = parsed.hostname.toLowerCase();
    if (h.includes('youtube') || h === 'youtu.be') return 'youtube';
    if (h.includes('twitch')) return 'twitch';
    if (h.includes('kick')) return 'kick';
    return '';
  } catch {
    return '';
  }
}

function fixCreatorChannels(c: CreatorRecord): CreatorRecord {
  const ch: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.channels || {})) {
    if ((PLATFORMS as readonly string[]).includes(k) && v) {
      ch[k] = v;
    }
  }
  if (c.channel) {
    const pk = platformKey(c.channel);
    if (pk && !Object.values(ch).includes(c.channel)) {
      ch[pk] = ch[pk] || c.channel;
    }
  }
  c.channels = ch;
  if (!c.ai_every_min) c.ai_every_min = 3;
  if (!Object.values(ch).includes(c.channel)) {
    c.channel = PLATFORMS.map((k) => ch[k]).find(Boolean) || '';
  }
  return c;
}

function cleanCreatorPatch(data: Record<string, unknown>): Partial<CreatorRecord> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(CREATOR_DEFAULTS)) {
    if (k === 'captions') {
      if (k in data) {
        if (typeof data[k] !== 'boolean') throw new Error('Captions must be on or off.');
        out[k] = data[k];
      }
      continue;
    }
    if (!(k in data) || data[k] === null || data[k] === undefined) continue;
    const v = data[k];
    if (k in CREATOR_NUMERIC) {
      const [lo, hi] = CREATOR_NUMERIC[k];
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(lo, Math.min(hi, n));
    } else if (k === 'auto_watch' || k === 'autopost' || k === 'ai_only_on_spike') {
      out[k] = Boolean(v);
    } else if (k === 'channels') {
      const next: Record<string, string> = {};
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [p, u] of Object.entries(v as Record<string, unknown>)) {
          const s = String(u || '').trim().slice(0, 300);
          if ((PLATFORMS as readonly string[]).includes(p) && s) {
            next[p] = s;
          }
        }
      }
      out[k] = next;
    } else if (k === 'accounts') {
      out[k] = Array.isArray(v) ? v.slice(0, 20).map(String) : [];
    } else if (k === 'rate_per_1k') {
      const f = Number(v || 0);
      out[k] = Number.isFinite(f) ? Math.max(0, Math.min(1000, f)) : 0;
    } else if (k === 'plan') {
      out[k] = v === 'pro' || v === 'max' ? v : 'free';
    } else if (k === 'decide_mode') {
      out[k] = v === 'either' ? 'either' : 'both';
    } else if (k === 'privacy') {
      out[k] = v === 'unlisted' || v === 'private' ? v : 'public';
    } else {
      out[k] = String(v).trim().slice(0, 300);
    }
  }
  return out as Partial<CreatorRecord>;
}

function userCreatorsMap(uid: string): Map<string, CreatorRecord> {
  let m = creators.get(uid);
  if (!m) {
    m = new Map();
    creators.set(uid, m);
  }
  return m;
}

export function listCreators(uid: string): CreatorRecord[] {
  return Array.from(userCreatorsMap(uid).values());
}

export function getCreator(uid: string, cid: string): CreatorRecord | null {
  return userCreatorsMap(uid).get(cid) || null;
}

export function creatorLogKey(uid: string, cid: string): string {
  return `${uid}:${cid}`;
}

export function appendCreatorLog(uid: string, cid: string, msg: string): void {
  const k = creatorLogKey(uid, cid);
  const arr = creatorLogs.get(k) || [];
  arr.push({ t: nowSec(), msg });
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  creatorLogs.set(k, arr);
  bump(uid);
}

export function readCreatorLog(uid: string, cid: string, n = 30): CreatorLogEntry[] {
  const arr = creatorLogs.get(creatorLogKey(uid, cid)) || [];
  return arr.slice(-n).reverse();
}

export function createCreator(uid: string, data: Record<string, unknown>): CreatorRecord {
  const map = userCreatorsMap(uid);
  const patch = cleanCreatorPatch(data);
  const name = (patch.name || '').trim();
  if (!name) throw new Error('Give the creator a name.');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'creator';
  let cid = slug;
  let n = 2;
  while (map.has(cid)) {
    cid = `${slug}-${n++}`;
  }
  const c: CreatorRecord = fixCreatorChannels({
    ...CREATOR_DEFAULTS,
    ...patch,
    id: cid,
    user: uid,
    created: nowSec(),
  });
  map.set(cid, c);
  appendCreatorLog(uid, cid, `Workspace created for ${c.name}`);
  bump(uid);
  return c;
}

export function updateCreator(uid: string, cid: string, data: Record<string, unknown>): CreatorRecord {
  const map = userCreatorsMap(uid);
  const existing = map.get(cid);
  if (!existing) throw new Error('NOT_FOUND');
  const patch = cleanCreatorPatch(data);
  const updated: CreatorRecord = { ...existing, ...patch };
  if ('channels' in patch && !('channel' in patch) && !Object.values(updated.channels).includes(updated.channel)) {
    updated.channel = '';
  }
  if ('channel' in patch && patch.channel && !('channels' in patch)) {
    const pk = platformKey(patch.channel);
    if (pk) updated.channels = { ...updated.channels, [pk]: patch.channel };
  }
  fixCreatorChannels(updated);
  if (updated.min_len >= updated.max_len) {
    throw new Error('Shortest clip must be shorter than longest clip.');
  }
  map.set(cid, updated);
  bump(uid);
  return updated;
}

export function deleteCreator(uid: string, cid: string): boolean {
  const map = userCreatorsMap(uid);
  if (!map.has(cid)) return false;
  map.delete(cid);
  creatorLogs.delete(creatorLogKey(uid, cid));
  for (const j of listUserJobs(uid)) {
    if (j.creator === cid) {
      removeJob(uid, j.id);
    }
  }
  bump(uid);
  return true;
}

// ------------------------------------------------------------------ Settings & Accounts & Apps
export function getSettings(uid: string): UserSettings {
  let s = settingsByUser.get(uid);
  if (!s) {
    s = { ...SETTING_DEFAULTS };
    settingsByUser.set(uid, s);
  }
  return { ...s };
}

export function publicSettings(uid: string): Record<string, unknown> {
  const s = getSettings(uid);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] = SECRET_KEYS.has(k) ? Boolean(v) : v;
  }
  return out;
}

export function saveSettings(uid: string, patch: Record<string, unknown>): UserSettings {
  const s = getSettings(uid);
  for (const [k, raw] of Object.entries(patch || {})) {
    if (!(k in SETTING_DEFAULTS)) continue;
    if (k === 'paused' || k === 'tour_done') {
      (s as unknown as Record<string, unknown>)[k] = Boolean(raw);
    } else if (k === 'digest_hour') {
      const h = Math.trunc(Number(raw));
      if (Number.isFinite(h)) s.digest_hour = Math.max(0, Math.min(23, h));
    } else {
      const v = String(raw ?? '').trim().slice(0, 300);
      if (k === 'discord_webhook' && v && !v.startsWith('https://discord.com/api/webhooks/')) {
        throw new Error("That doesn't look like a Discord webhook link.");
      }
      if (SECRET_KEYS.has(k) && v === '') continue;
      (s as unknown as Record<string, unknown>)[k] = v;
    }
  }
  settingsByUser.set(uid, s);
  bump(uid);
  return s;
}

export function alertsConfigured(uid: string): boolean {
  const s = getSettings(uid);
  return Boolean(s.discord_webhook || (s.telegram_token && s.telegram_chat));
}

export function listAccounts(uid: string) {
  return (accountsByUser.get(uid) || []).map((a) => ({
    id: a.id,
    platform: a.platform,
    label: PLATFORM_NAMES[a.platform] || a.platform,
    name: a.name,
    added: a.added,
    detail: a.detail || '',
  }));
}

export function removeAccount(uid: string, aid: string): void {
  const list = (accountsByUser.get(uid) || []).filter((a) => a.id !== aid);
  accountsByUser.set(uid, list);
  bump(uid);
}

export function appKeys(name: string): [string, string] {
  const saved = savedApps[name];
  if (saved?.id && saved?.secret) return [saved.id, saved.secret];
  const meta = APPS_META[name];
  if (!meta) return ['', ''];
  return [(process.env[meta[2]] || '').trim(), (process.env[meta[3]] || '').trim()];
}

export function canConnect(platform: string): boolean {
  const name = APP_FOR[platform];
  if (!name) return false;
  const [cid, sec] = appKeys(name);
  return Boolean(cid && sec);
}

export function appsPublic() {
  const out: Record<string, unknown> = {};
  for (const [platform, name] of Object.entries(APP_FOR)) {
    const [cid, sec] = appKeys(name);
    const meta = APPS_META[name];
    out[platform] = {
      ready: Boolean(cid && sec),
      id_label: meta[0],
      secret_label: meta[1],
      id_hint: cid.length > 10 ? cid.slice(0, 6) + '…' : cid,
      redirect: `${PUBLIC_URL}/oauth/${platform}/callback`,
      https: PUBLIC_URL.startsWith('https://'),
      from_dashboard: Boolean(savedApps[name]?.id),
    };
  }
  return out;
}

export function saveApp(platform: string, cidRaw: unknown, secretRaw: unknown) {
  const name = APP_FOR[platform];
  if (!name) throw new Error('Unknown platform.');
  const meta = APPS_META[name];
  let cid = String(cidRaw || '').trim().slice(0, 200);
  let secret = String(secretRaw || '').trim().slice(0, 300);
  const old = savedApps[name] || { id: '', secret: '' };
  if (!cid && !secret) throw new Error(`Paste the ${meta[0]} and ${meta[1]}.`);
  cid = cid || old.id;
  if (!/^[\w.\-]{4,200}$/.test(cid)) {
    throw new Error(`Paste the ${meta[0]} exactly as the platform shows it.`);
  }
  secret = secret || (old.id === cid ? old.secret : '');
  if (!secret) throw new Error(`Paste the ${meta[1]} too.`);
  savedApps[name] = { id: cid, secret };
  return appsPublic();
}

// ------------------------------------------------------------------ Posts & Overview
export function listPosts(uid: string): PostItem[] {
  return postsByUser.get(uid) || [];
}

export function enqueuePosts(uid: string, job: JobRecord, clipId: string, accountIds: string[], now = false): PostItem[] {
  const clip = job.clips.find((c) => c.id === clipId);
  if (!clip || clip.status !== 'done') return [];
  const accs = accountsByUser.get(uid) || [];
  const list = postsByUser.get(uid) || [];
  const created: PostItem[] = [];
  for (const aid of accountIds.slice(0, 20)) {
    const acc = accs.find((a) => a.id === aid);
    if (!acc) continue;
    if (list.some((p) => p.job === job.id && p.clip === clipId && p.account === aid && p.status !== 'cancelled')) {
      continue;
    }
    const item: PostItem = {
      id: 'p_' + crypto.randomBytes(6).toString('hex'),
      user: uid,
      creator: job.creator,
      job: job.id,
      clip: clipId,
      title: clip.title || clip.hook || job.title,
      account: acc.id,
      account_name: acc.name,
      platform: acc.platform,
      status: 'queued',
      due_at: now ? nowSec() : nowSec() + 1800,
      posted_at: 0,
      views: 0,
      url: '',
      error: '',
    };
    list.push(item);
    created.push(item);
  }
  postsByUser.set(uid, list);
  bump(uid);
  return created;
}

export function postAction(uid: string, pid: string, action: 'cancel' | 'retry'): void {
  const list = postsByUser.get(uid) || [];
  const p = list.find((x) => x.id === pid);
  if (!p) throw new Error('No such scheduled post.');
  if (action === 'cancel') {
    p.status = 'cancelled';
  } else {
    p.status = 'queued';
    p.error = '';
    p.due_at = nowSec();
  }
  bump(uid);
}

export function getOverview(uid: string) {
  const today = dayKey(nowSec());
  const allCs = listCreators(uid);
  const allJs = listUserJobs(uid);
  const myPosts = listPosts(uid);
  const openStatuses = new Set(['queued', 'posting']);

  const rows = allCs.map((c) => {
    const js = allJs.filter((j) => j.creator === c.id);
    const clips = js.flatMap((j) => j.clips.filter((k) => k.status === 'done'));
    const ps = myPosts.filter((p) => p.creator === c.id);
    const views = ps.reduce((s, p) => s + (p.views || 0), 0);
    return {
      id: c.id,
      name: c.name,
      state: c.auto_watch && c.channel ? 'waiting' : 'idle',
      autopost: c.autopost && c.accounts.length > 0,
      clips_today: clips.filter((k) => dayKey(k.made_at || 0) === today).length,
      clips_total: clips.length,
      posted_today: ps.filter((p) => p.status === 'posted' && dayKey(p.posted_at) === today).length,
      posted_total: ps.filter((p) => p.status === 'posted').length,
      queued: ps.filter((p) => openStatuses.has(p.status)).length,
      failed: ps.filter((p) => p.status === 'failed').length,
      views,
      earnings: Number(((views / 1000) * c.rate_per_1k).toFixed(2)),
    };
  });

  const names = Object.fromEntries(allCs.map((c) => [c.id, c.name]));
  const queue = myPosts.filter((p) => openStatuses.has(p.status)).sort((a, b) => a.due_at - b.due_at);
  const done = myPosts
    .filter((p) => p.status === 'posted' || p.status === 'failed')
    .sort((a, b) => (b.posted_at || b.due_at) - (a.posted_at || a.due_at))
    .slice(0, 15);
  const show = [...queue, ...done].map((p) => {
    const { user: _u, ...rest } = p;
    return { ...rest, creator_name: p.creator ? names[p.creator] || '' : '' };
  });

  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    days.push(dayKey(nowSec() - 86400 * i));
  }
  const made = Object.fromEntries(days.map((d) => [d, 0]));
  const posted = Object.fromEntries(days.map((d) => [d, 0]));
  const views = Object.fromEntries(days.map((d) => [d, 0]));

  for (const j of allJs) {
    for (const k of j.clips) {
      const d = dayKey(k.made_at || j.created);
      if (k.status === 'done' && d in made) made[d] += 1;
    }
  }
  for (const p of myPosts) {
    const d = dayKey(p.posted_at);
    if (p.status === 'posted' && d in posted) {
      posted[d] += 1;
      views[d] += p.views || 0;
    }
  }

  return {
    paused: getSettings(uid).paused,
    creators: rows,
    posts: show,
    daily: days.map((d) => ({ day: d, clips: made[d], posted: posted[d], views: views[d] })),
    alerts: alertsConfigured(uid),
    recording: 0,
  };
}

// ------------------------------------------------------------------ Usage
export function recordUsage(
  uid: string,
  tokensIn: number,
  tokensOut: number,
  purpose: string,
  place = '',
  creator: string | null = null,
): void {
  usageRows.push({
    t: nowSec(),
    user_id: uid,
    tokens_in: Math.max(0, Math.trunc(tokensIn)),
    tokens_out: Math.max(0, Math.trunc(tokensOut)),
    purpose: purpose.slice(0, 60),
    place: place.slice(0, 200),
    creator,
  });
  bump(uid);
}

export function usageBrief(uid: string, aiMeta: { ready: boolean; provider: string; model: string; problem: string }) {
  const today = dayKey(nowSec());
  const todays = usageRows.filter((u) => u.user_id === uid && dayKey(u.t) === today);
  return {
    ready: aiMeta.ready,
    provider: aiMeta.provider,
    model: aiMeta.model,
    today_calls: todays.length,
    today_tokens: todays.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0),
    problem: aiMeta.problem,
  };
}

export function usageSummary(
  uid: string,
  creatorNames: Record<string, string>,
  aiMeta: { ready: boolean; provider: string; model: string; problem: string },
) {
  const mine = usageRows.filter((u) => u.user_id === uid);
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(nowSec() - 86400 * i));
  const dailyMap = Object.fromEntries(days.map((d) => [d, [0, 0]]));
  const byPurposeMap = new Map<string, [number, number]>();
  const byCreatorMap = new Map<string, [number, number]>();

  let totalTokens = 0;
  for (const r of mine) {
    const tok = r.tokens_in + r.tokens_out;
    totalTokens += tok;
    const d = dayKey(r.t);
    if (d in dailyMap) {
      dailyMap[d][0] += tok;
      dailyMap[d][1] += 1;
    }
    const p = byPurposeMap.get(r.purpose) || [0, 0];
    p[0] += tok;
    p[1] += 1;
    byPurposeMap.set(r.purpose, p);

    const cname = r.creator ? creatorNames[r.creator] || r.creator : 'Direct videos';
    const c = byCreatorMap.get(cname) || [0, 0];
    c[0] += tok;
    c[1] += 1;
    byCreatorMap.set(cname, c);
  }

  return {
    ...usageBrief(uid, aiMeta),
    calls_total: mine.length,
    tokens_total: totalTokens,
    daily: days.map((d) => ({ day: d, tokens: dailyMap[d][0], calls: dailyMap[d][1] })),
    by_purpose: Array.from(byPurposeMap.entries())
      .map(([k, v]) => [k, v[0], v[1]])
      .sort((a, b) => (b[1] as number) - (a[1] as number)),
    by_creator: Array.from(byCreatorMap.entries())
      .map(([k, v]) => [k, v[0], v[1]])
      .sort((a, b) => (b[1] as number) - (a[1] as number)),
    recent: mine
      .slice(-60)
      .reverse()
      .map((r) => ({
        t: r.t,
        tokens: r.tokens_in + r.tokens_out,
        purpose: r.purpose,
        where: r.place,
        creator_name: r.creator ? creatorNames[r.creator] || '' : '',
      })),
  };
}

// ------------------------------------------------------------------ Notices & Feedback
export function addNotice(uid: string, kind: string, title: string, body = '', link = '', ref?: string): void {
  if (ref && notices.some((n) => n.user_id === uid && n.ref === ref)) return;
  notices.unshift({
    id: nextNoticeId++,
    user_id: uid,
    t: nowSec(),
    kind: kind.slice(0, 20),
    title: title.slice(0, 160),
    body: body.slice(0, 400),
    link: link.slice(0, 200),
    ref,
    read_at: null,
  });
  if (notices.length > 400) notices.length = 400;
  bump(uid);
}

export function unreadNoticesCount(uid: string): number {
  return notices.filter((n) => n.user_id === uid && !n.read_at).length;
}

export function listNotices(uid: string, limit = 40) {
  const mine = notices.filter((n) => n.user_id === uid);
  return {
    unread: mine.filter((n) => !n.read_at).length,
    items: mine.slice(0, limit).map((n) => ({
      id: n.id,
      t: n.t,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      read: Boolean(n.read_at),
    })),
  };
}

export function markAllNoticesRead(uid: string): void {
  const now = nowSec();
  for (const n of notices) {
    if (n.user_id === uid && !n.read_at) n.read_at = now;
  }
  bump(uid);
}

export function submitFeedback(uid: string, kind: string, message: string, page = '', context = '') {
  const cleanMsg = (message || '').trim();
  if (cleanMsg.length < 3) throw new Error('Write a few words so we know what you mean.');
  if (cleanMsg.length > 4000) throw new Error("That's a bit long. Keep it under 4,000 characters.");
  const k: 'bug' | 'idea' | 'other' = kind === 'bug' || kind === 'idea' ? kind : 'other';
  const item: FeedbackItem = {
    id: nextFeedbackId++,
    user_id: uid,
    t: nowSec(),
    kind: k,
    message: cleanMsg,
    page: page.slice(0, 200),
    context: context.slice(0, 1000),
    status: 'new',
    updated_at: nowSec(),
  };
  feedbackItems.unshift(item);
  return { id: item.id };
}

export function listFeedback(status = '') {
  const items = feedbackItems
    .filter((f) => (!status || f.status === status))
    .slice(0, 300)
    .map((f) => {
      const u = users.get(f.user_id);
      return {
        id: f.id,
        t: f.t,
        kind: f.kind,
        message: f.message,
        page: f.page,
        context: f.context,
        status: f.status,
        email: u?.email || '',
        name: u?.name || '',
      };
    });
  const counts = { new: 0, seen: 0, done: 0 };
  for (const f of feedbackItems) counts[f.status] += 1;
  return { items, counts };
}

export function setFeedbackStatus(fid: number, status: string): void {
  if (status !== 'new' && status !== 'seen' && status !== 'done') throw new Error('Unknown status.');
  const item = feedbackItems.find((f) => f.id === fid);
  if (!item) throw new Error('That message no longer exists.');
  item.status = status;
  item.updated_at = nowSec();
}

// ------------------------------------------------------------------ Uploads
export function putUpload(session: UploadSession): void {
  uploads.set(session.id, session);
}

export function getUpload(uid: string, upid: string): UploadSession | null {
  const s = uploads.get(upid);
  return s && s.user === uid ? s : null;
}

export function removeUpload(upid: string): void {
  const s = uploads.get(upid);
  uploads.delete(upid);
  if (s) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function countUserUploads(uid: string): number {
  let n = 0;
  for (const s of uploads.values()) {
    if (s.user === uid) n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ Storage & Admin
function folderBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += folderBytes(p);
      else total += fs.statSync(p).size;
    }
  } catch {
    // ignore
  }
  return total;
}

export function storageInfo(local: boolean) {
  let freeGb = 10;
  let totalGb = 20;
  try {
    const stat = fs.statfsSync(DATA_DIR);
    freeGb = (stat.bavail * stat.bsize) / 1e9;
    totalGb = (stat.blocks * stat.bsize) / 1e9;
  } catch {
    // fallback defaults
  }
  const usedGb = folderBytes(DATA_DIR) / 1e9;
  return {
    path: DATA_DIR,
    drive: path.parse(DATA_DIR).root || '/',
    free_gb: Number(freeGb.toFixed(1)),
    total_gb: Number(totalGb.toFixed(1)),
    used_gb: Number(usedGb.toFixed(2)),
    min_free_gb: MIN_FREE_DISK_GB,
    full: freeGb < MIN_FREE_DISK_GB,
    fixed: DATA_FROM === 'env',
    pending: '',
    local,
  };
}

export function adminOverview(aiMeta: { ready: boolean; provider: string; model: string }) {
  const now = nowSec();
  const today = dayKey(now);
  const allU = Array.from(users.values());
  const allJ = allJobs();
  const sInfo = storageInfo(false);

  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(now - 86400 * i));
  const daily = days.map((d) => ({
    day: d,
    signups: allU.filter((u) => dayKey(u.created_at) === d).length,
    calls: usageRows.filter((r) => dayKey(r.t) === d).length,
    tokens: usageRows.filter((r) => dayKey(r.t) === d).reduce((s, r) => s + r.tokens_in + r.tokens_out, 0),
  }));

  const byPurposeMap = new Map<string, [number, number]>();
  for (const r of usageRows) {
    const cur = byPurposeMap.get(r.purpose) || [0, 0];
    cur[0] += r.tokens_in + r.tokens_out;
    cur[1] += 1;
    byPurposeMap.set(r.purpose, cur);
  }

  const userRows = allU.map((u) => {
    const uJobs = allJ.filter((j) => j.user === u.id);
    const uUse = usageRows.filter((r) => r.user_id === u.id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.is_admin ? 'admin' : 'user',
      verified: u.verified,
      disabled: u.disabled,
      created_at: u.created_at,
      last_seen: u.last_seen,
      calls: uUse.length,
      tokens: uUse.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0),
      videos: uJobs.length,
      clips: uJobs.reduce((s, j) => s + j.clips.length, 0),
    };
  });

  return {
    totals: {
      users: userRows.length,
      verified: userRows.filter((u) => u.verified).length,
      disabled: userRows.filter((u) => u.disabled).length,
      admins: userRows.filter((u) => u.role === 'admin').length,
      signups_today: userRows.filter((u) => dayKey(u.created_at) === today).length,
      signups_7d: userRows.filter((u) => u.created_at >= now - 7 * 86400).length,
      signups_30d: userRows.filter((u) => u.created_at >= now - 30 * 86400).length,
      active_7d: userRows.filter((u) => u.last_seen >= now - 7 * 86400).length,
      ai_calls: usageRows.length,
      ai_calls_today: usageRows.filter((r) => dayKey(r.t) === today).length,
      tokens: usageRows.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0),
      videos: allJ.length,
      clips: allJ.reduce((s, j) => s + j.clips.length, 0),
      recording: 0,
      working: allJ.filter((j) => j.status === 'queued' || j.status === 'running').length,
    },
    daily,
    by_purpose: Array.from(byPurposeMap.entries()).map(([k, v]) => [k, v[0], v[1]]),
    users: userRows,
    log: adminLog.slice(0, 50),
    server: {
      speech_model: true,
      ai_key: aiMeta.ready,
      ai_provider: aiMeta.provider,
      ai_model: aiMeta.model,
      google: canConnect('youtube'),
      mail: false,
      free_gb: sInfo.free_gb,
      load: 'ok',
      running: allJ.filter((j) => j.status === 'running').length,
      waiting: allJ.filter((j) => j.status === 'queued').length,
      database: 'in-memory',
    },
  };
}

export function adminUserDetail(uid: string) {
  const u = users.get(uid);
  if (!u) return null;
  const mine = usageRows.filter((r) => r.user_id === uid);
  const byP = new Map<string, [number, number]>();
  for (const r of mine) {
    const cur = byP.get(r.purpose) || [0, 0];
    cur[0] += r.tokens_in + r.tokens_out;
    cur[1] += 1;
    byP.set(r.purpose, cur);
  }
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.is_admin ? 'admin' : 'user',
    disabled: u.disabled,
    created_at: u.created_at,
    last_seen: u.last_seen,
    signed_in_devices: Array.from(sessions.values()).filter((s) => s.user_id === uid).length,
    recent: mine.slice(-40).reverse().map((r) => ({
      t: r.t,
      tokens: r.tokens_in + r.tokens_out,
      purpose: r.purpose,
    })),
    by_purpose: Array.from(byP.entries()).map(([k, v]) => [k, v[0], v[1]]),
  };
}

export function deleteAccount(uid: string): void {
  for (const j of listUserJobs(uid)) {
    removeJob(uid, j.id);
  }
  creators.delete(uid);
  settingsByUser.delete(uid);
  accountsByUser.delete(uid);
  postsByUser.delete(uid);
  users.delete(uid);
  for (const [tok, s] of sessions.entries()) {
    if (s.user_id === uid) sessions.delete(tok);
  }
  try {
    fs.rmSync(userDir(uid), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function setUserDisabled(adminId: string, uid: string, disabled: boolean): void {
  const u = users.get(uid);
  if (!u) throw new Error('No such account');
  if (u.id === adminId) throw new Error("You can't disable your own account.");
  if (u.is_admin) throw new Error("Admin accounts can't be disabled from here.");
  u.disabled = disabled;
  if (disabled) {
    for (const [tok, s] of sessions.entries()) {
      if (s.user_id === uid) sessions.delete(tok);
    }
  }
  adminLog.unshift({
    t: nowSec(),
    admin: adminId,
    action: disabled ? 'disable' : 'enable',
    target: uid,
    detail: '',
  });
}
