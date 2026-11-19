import 'dotenv/config';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import multer from 'multer';
import path from 'node:path';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as (
  format: 'zip' | 'tar',
  options?: { zlib?: { level?: number } },
) => import('archiver').Archiver;
import {
  explainError,
  getAiMeta,
  listModels,
  publicAiConfig,
  saveAiConfig,
  testAi,
} from './server/ai.ts';
import {
  ACCOUNTS,
  CONTACT_EMAIL,
  FOLLOW_URL,
  HOST,
  LEGAL_COUNTRY,
  LEGAL_NAME,
  MAX_ACTIVE_JOBS_PER_USER,
  MAX_CREATORS,
  MAX_UPLOAD_MB,
  PORT,
  PUBLIC_URL,
  REPO_URL,
  UPLOAD_PART_MB,
  UPLOADS_DIR,
  VERIFY_EMAIL,
  VIDEO_EXTENSIONS,
  WEB_DIR,
  ensureDirs,
  hasFfmpeg,
} from './server/config.ts';
import {
  cleanOptions,
  createJob,
  enqueueJob,
  previewChannel,
  previewLink,
  publicJob,
  requestClipRender,
  siteAllowed,
} from './server/jobs.ts';
import { LAYOUTS, STYLES } from './server/render.ts';
import {
  BOOT,
  PLATFORM_NAMES,
  SESSION_COOKIE,
  adminOverview,
  adminUserDetail,
  alertsConfigured,
  appsPublic,
  bump,
  busyJobsCount,
  canConnect,
  changeUserPassword,
  countUserUploads,
  createCreator,
  createSession,
  deleteAccount,
  deleteCreator,
  endSession,
  enqueuePosts,
  getCreator,
  getJob,
  getOverview,
  getSettings,
  getUpload,
  getVersion,
  listAccounts,
  listCreators,
  listFeedback,
  listNotices,
  listUserJobs,
  localUser,
  loginUser,
  markAllNoticesRead,
  nowSec,
  platformKey,
  postAction,
  publicSettings,
  publicUser,
  putJob,
  putUpload,
  readCreatorLog,
  removeAccount,
  removeJob,
  removeUpload,
  saveApp,
  saveSettings,
  setFeedbackStatus,
  setUserDisabled,
  signupUser,
  storageInfo,
  submitFeedback,
  throttle,
  unreadNoticesCount,
  updateCreator,
  usageBrief,
  usageSummary,
  userForSession,
} from './server/store.ts';
import type { UserRecord } from './server/types.ts';

ensureDirs();

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());

// Security headers (iframe-compatible for AI Studio preview)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Body parsers: raw binary for chunked upload parts, JSON for API routes
app.use('/api/upload/:upid/:n', express.raw({ type: '*/*', limit: `${UPLOAD_PART_MB + 8}mb` }));
app.use(express.json({ limit: '512kb' }));

const uploadMulter = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

interface AuthedRequest extends Request {
  user?: UserRecord | null;
}

function getUser(req: AuthedRequest): UserRecord | null {
  if (!ACCOUNTS) return localUser();
  const tok = req.cookies?.[SESSION_COOKIE];
  return userForSession(tok);
}

function requireUser(req: AuthedRequest, res: Response, next: NextFunction): void {
  const u = getUser(req);
  if (!u) {
    res.status(401).json({ detail: 'Please sign in.' });
    return;
  }
  req.user = u;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const u = getUser(req);
  if (!u || !u.is_admin || u.disabled) {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  req.user = u;
  next();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLanding(res: Response): void {
  const f = path.join(WEB_DIR, 'landing.html');
  const html = fs.readFileSync(f, 'utf-8').replaceAll('{{SITE}}', PUBLIC_URL);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(html);
}

// ================================================================ Pages & Static Assets
app.get('/', (_req, res) => {
  if (!ACCOUNTS) {
    res.redirect(303, '/app');
    return;
  }
  renderLanding(res);
});

app.get('/landing', (_req, res) => {
  renderLanding(res);
});

app.get(['/app', '/app/*'], (req: AuthedRequest, res) => {
  const u = getUser(req);
  if (!u) {
    res.redirect(303, '/login');
    return;
  }
  res.setHeader('Cache-Control', 'private, no-cache');
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

app.get(['/admin', '/admin/*'], (req: AuthedRequest, res) => {
  const u = getUser(req);
  if (!u || !u.is_admin) {
    res.status(404).send('Not Found');
    return;
  }
  res.setHeader('Cache-Control', 'private, no-cache');
  res.sendFile(path.join(WEB_DIR, 'admin.html'));
});

app.get(['/login', '/signup'], (req: AuthedRequest, res) => {
  if (getUser(req)) {
    res.redirect(303, '/app');
    return;
  }
  res.sendFile(path.join(WEB_DIR, 'auth.html'));
});

app.get('/reset', (_req, res) => {
  if (!ACCOUNTS) {
    res.redirect(303, '/app');
    return;
  }
  res.sendFile(path.join(WEB_DIR, 'reset.html'));
});

const LEGAL_PAGES: Record<string, [string, string]> = {
  privacy: ['Privacy Policy', 'How PeakCut collects, uses and protects your data, cookies and privacy rights.'],
  terms: ['Terms of Service', 'The terms for using PeakCut, the AI clipping tool for streams and videos.'],
  'acceptable-use': ['Acceptable Use Policy', 'What you may and may not do with PeakCut.'],
};

app.get(['/privacy', '/terms', '/acceptable-use'], (req, res) => {
  const page = req.path.replace(/^\/+/, '');
  const [title, desc] = LEGAL_PAGES[page] || ['Legal', ''];
  const who = CONTACT_EMAIL
    ? `<a href="mailto:${escapeHtml(CONTACT_EMAIL)}">${escapeHtml(CONTACT_EMAIL)}</a>`
    : 'the contact details on our website';
  const law = LEGAL_COUNTRY
    ? `the laws of ${escapeHtml(LEGAL_COUNTRY)}`
    : "the laws of the country where PeakCut's operator is established";
  let html = fs.readFileSync(path.join(WEB_DIR, 'legal.html'), 'utf-8');
  const vars: Record<string, string> = {
    '{{CONTACT}}': who,
    '{{PAGE}}': page,
    '{{PAGE_PATH}}': page,
    '{{SITE}}': escapeHtml(PUBLIC_URL),
    '{{NAME}}': escapeHtml(LEGAL_NAME),
    '{{LAW}}': law,
    '{{TITLE}}': title,
    '{{DESC}}': desc,
  };
  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll(k, v);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/brand/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+\.(svg|png|ico|webp|jpg|mp4)$/.test(name)) {
    res.status(404).end();
    return;
  }
  const f = path.join(WEB_DIR, 'brand', name);
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(f);
});

app.get('/assets/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w\-]+\.js$/.test(name)) {
    res.status(404).end();
    return;
  }
  const f = path.join(WEB_DIR, name);
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(f);
});

app.get('/favicon.ico', (_req, res) => {
  res.redirect(308, '/brand/favicon.svg');
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nDisallow: /auth/\nDisallow: /reset\nDisallow: /media/\n\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`,
  );
});

app.get('/sitemap.xml', (_req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  const pages = ['/', '/signup', '/login', '/terms', '/privacy', '/acceptable-use'];
  const body = pages
    .map((u) => `<url><loc>${PUBLIC_URL}${u}</loc><lastmod>${day}</lastmod></url>`)
    .join('');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// ================================================================ Auth
app.get('/api/public', (_req, res) => {
  res.json({ google: false, mail: false, verify_email: VERIFY_EMAIL });
});

app.get('/api/auth/me', (req: AuthedRequest, res) => {
  const u = getUser(req);
  res.json({ user: u ? publicUser(u) : null });
});

app.post('/api/auth/signup', (req, res) => {
  if (!ACCOUNTS) {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  try {
    const u = signupUser(String(req.body?.email || ''), String(req.body?.password || ''), String(req.body?.name || ''));
    const tok = createSession(u.id);
    res.cookie(SESSION_COOKIE, tok, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86400 * 1000 });
    res.json({ user: publicUser(u) });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Signup failed.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  if (!ACCOUNTS) {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  try {
    const u = loginUser(String(req.body?.email || ''), String(req.body?.password || ''));
    const tok = createSession(u.id);
    res.cookie(SESSION_COOKIE, tok, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86400 * 1000 });
    res.json({ user: publicUser(u) });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  endSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/auth/password', requireUser, (req: AuthedRequest, res) => {
  try {
    changeUserPassword(req.user!.id, String(req.body?.current || ''), String(req.body?.new || ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not change password.' });
  }
});

app.post('/api/auth/forgot', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/reset', (_req, res) => {
  res.status(400).json({ detail: 'Password reset emails are not configured on this server.' });
});

app.post('/api/auth/resend-verification', requireUser, (_req, res) => {
  res.json({ verified: true });
});

app.get('/api/me/photo', requireUser, (_req, res) => {
  res.status(404).end();
});

app.post('/api/account/delete', requireUser, (req: AuthedRequest, res) => {
  const me = req.user!;
  if (String(req.body?.confirm || '').trim().toLowerCase() !== me.email.toLowerCase()) {
    res.status(400).json({ detail: 'Type your email address exactly to confirm.' });
    return;
  }
  deleteAccount(me.id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ================================================================ Status & Sync
function creatorRows(uid: string) {
  return listCreators(uid).map((c) => ({
    ...c,
    live_job: null,
    log: readCreatorLog(uid, c.id, 30),
  }));
}

app.get('/api/status', requireUser, (req: AuthedRequest, res) => {
  const me = req.user!;
  const sInfo = storageInfo(false);
  res.json({
    user: publicUser(me),
    update: null,
    accounts: ACCOUNTS,
    disk_full: sInfo.full,
    no_ffmpeg: !hasFfmpeg(),
    links: { repo: REPO_URL, follow: FOLLOW_URL },
    ai: usageBrief(me.id, getAiMeta()),
    unread: unreadNoticesCount(me.id),
    tour: !getSettings(me.id).tour_done,
    youtube: canConnect('youtube'),
    connect: Object.fromEntries(Object.keys(PLATFORM_NAMES).map((p) => [p, canConnect(p)])),
    max_upload_mb: MAX_UPLOAD_MB,
    upload_part_mb: UPLOAD_PART_MB,
    max_batch: MAX_ACTIVE_JOBS_PER_USER,
    styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.label])),
    layouts: LAYOUTS,
  });
});

app.get('/api/sync', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const v = String(req.query.v || '');
  const token = `${BOOT}.${getVersion(uid)}.0`;
  if (v && v === token) {
    res.json({ v: token });
    return;
  }
  res.json({
    v: token,
    jobs: listUserJobs(uid).map(publicJob),
    creators: creatorRows(uid),
    accounts: listAccounts(uid),
    ai: usageBrief(uid, getAiMeta()),
    unread: unreadNoticesCount(uid),
  });
});

// ================================================================ Videos, Uploads & Clips
app.get('/api/jobs', requireUser, (req: AuthedRequest, res) => {
  res.json(listUserJobs(req.user!.id).map(publicJob));
});

app.get('/api/jobs/:jid', requireUser, (req: AuthedRequest, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  res.json(publicJob(job));
});

app.get('/api/preview', requireUser, async (req: AuthedRequest, res) => {
  const url = String(req.query.url || '').trim().slice(0, 500);
  if (!siteAllowed(url)) {
    res.status(400).json({ detail: 'Paste a full link to a YouTube, Twitch or Kick video.' });
    return;
  }
  try {
    const info = await previewLink(url);
    res.json(info);
  } catch (err) {
    res.status(422).json({ detail: err instanceof Error ? err.message : "Couldn't open that video." });
  }
});

app.post('/api/jobs', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const url = String(req.body?.url || '').trim().slice(0, 500);
  if (!siteAllowed(url)) {
    res.status(400).json({ detail: 'Paste a full link to a YouTube, Twitch or Kick video.' });
    return;
  }
  if (busyJobsCount(uid) >= MAX_ACTIVE_JOBS_PER_USER) {
    res.status(429).json({
      detail: `You already have ${MAX_ACTIVE_JOBS_PER_USER} videos in progress. Wait for one to finish.`,
    });
    return;
  }
  const creator = req.body?.creator ? String(req.body.creator) : null;
  if (creator && !getCreator(uid, creator)) {
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  try {
    const job = createJob(uid, { type: 'url', url, name: url }, req.body?.options || {}, true, creator);
    res.json(publicJob(job));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : "Those options aren't valid." });
  }
});

app.post('/api/upload', requireUser, uploadMulter.single('file'), (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const file = req.file;
  if (!file) {
    res.status(400).json({ detail: 'Upload a video file (mp4, mov, mkv or webm).' });
    return;
  }
  const cleanName = path.basename(file.originalname || 'video.mp4').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const ext = path.extname(cleanName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    fs.rmSync(file.path, { force: true });
    res.status(400).json({ detail: 'Upload a video file (mp4, mov, mkv or webm).' });
    return;
  }
  if (busyJobsCount(uid) >= MAX_ACTIVE_JOBS_PER_USER) {
    fs.rmSync(file.path, { force: true });
    res.status(429).json({
      detail: `You already have ${MAX_ACTIVE_JOBS_PER_USER} videos in progress. Wait for one to finish.`,
    });
    return;
  }
  const creator = String(req.body?.creator || '') || null;
  if (creator && !getCreator(uid, creator)) {
    fs.rmSync(file.path, { force: true });
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  let opts: Record<string, unknown> = {};
  try {
    opts = JSON.parse(String(req.body?.options || '{}'));
  } catch {
    fs.rmSync(file.path, { force: true });
    res.status(400).json({ detail: "Those options aren't valid." });
    return;
  }
  try {
    const job = createJob(uid, { type: 'file', name: cleanName, path: '' }, opts, false, creator);
    const dest = path.join(job.dir, 'source' + ext);
    fs.copyFileSync(file.path, dest);
    fs.rmSync(file.path, { force: true });
    job.source.path = dest;
    job.source_path = dest;
    enqueueJob(job);
    res.json(publicJob(job));
  } catch (err) {
    fs.rmSync(file.path, { force: true });
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Upload failed.' });
  }
});

// Chunked uploads
app.post('/api/upload/start', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  if (busyJobsCount(uid) >= MAX_ACTIVE_JOBS_PER_USER) {
    res.status(429).json({
      detail: `You already have ${MAX_ACTIVE_JOBS_PER_USER} videos in progress. Wait for one to finish.`,
    });
    return;
  }
  const cleanName = path.basename(String(req.body?.name || 'video.mp4')).replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const ext = path.extname(cleanName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    res.status(400).json({ detail: 'Upload a video file (mp4, mov, mkv or webm).' });
    return;
  }
  const size = req.body?.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    res.status(400).json({ detail: 'Bad file size.' });
    return;
  }
  if (size > MAX_UPLOAD_MB * 1024 * 1024) {
    res.status(413).json({ detail: `That file is too big. The limit is ${MAX_UPLOAD_MB} MB.` });
    return;
  }
  const creator = String(req.body?.creator || '');
  if (creator && !getCreator(uid, creator)) {
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  const opts = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
  try {
    cleanOptions(opts);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : "Those options aren't valid." });
    return;
  }
  if (countUserUploads(uid) >= MAX_ACTIVE_JOBS_PER_USER) {
    res.status(429).json({ detail: 'You already have several uploads in progress. Let one finish first.' });
    return;
  }

  const part = UPLOAD_PART_MB * 1024 * 1024;
  const parts = Math.ceil(size / part);
  const upid = crypto.randomBytes(12).toString('hex');
  const dir = path.join(UPLOADS_DIR, `up-${upid}`);
  fs.mkdirSync(dir, { recursive: true });

  putUpload({ id: upid, user: uid, name: cleanName, ext, size, part, parts, options: opts, creator, t: nowSec(), dir });
  res.json({ id: upid, part, parts });
});

app.put('/api/upload/:upid/:n', requireUser, (req: AuthedRequest, res) => {
  const meta = getUpload(req.user!.id, req.params.upid);
  if (!meta) {
    res.status(404).json({ detail: 'No such upload' });
    return;
  }
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n >= meta.parts) {
    res.status(400).json({ detail: 'No such piece.' });
    return;
  }
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const want = n < meta.parts - 1 ? meta.part : meta.size - meta.part * (meta.parts - 1);
  if (buf.length !== want) {
    res.status(400).json({ detail: 'That piece is the wrong size.' });
    return;
  }
  fs.writeFileSync(path.join(meta.dir, `${String(n).padStart(5, '0')}.part`), buf);
  res.json({ ok: true, n });
});

app.post('/api/upload/:upid/finish', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const meta = getUpload(uid, req.params.upid);
  if (!meta) {
    res.status(404).json({ detail: 'This upload has expired. Start it again.' });
    return;
  }
  const partPaths: string[] = [];
  for (let i = 0; i < meta.parts; i++) {
    const p = path.join(meta.dir, `${String(i).padStart(5, '0')}.part`);
    if (!fs.existsSync(p)) {
      res.status(409).json({ detail: `Piece ${i + 1} of ${meta.parts} has not arrived yet.` });
      return;
    }
    partPaths.push(p);
  }
  try {
    const job = createJob(uid, { type: 'file', name: meta.name, path: '' }, meta.options, false, meta.creator || null);
    const dest = path.join(job.dir, 'source' + meta.ext);
    const outFd = fs.openSync(dest, 'w');
    try {
      for (const p of partPaths) {
        const chunk = fs.readFileSync(p);
        fs.writeSync(outFd, chunk);
      }
    } finally {
      fs.closeSync(outFd);
    }
    removeUpload(meta.id);
    job.source.path = dest;
    job.source_path = dest;
    enqueueJob(job);
    res.json(publicJob(job));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not finish upload.' });
  }
});

app.delete('/api/upload/:upid', requireUser, (req: AuthedRequest, res) => {
  const meta = getUpload(req.user!.id, req.params.upid);
  if (!meta) {
    res.status(404).json({ detail: 'No such upload' });
    return;
  }
  removeUpload(meta.id);
  res.json({ ok: true });
});

app.post('/api/jobs/:jid/clips/:cid/render', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const job = getJob(uid, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  const clip = job.clips.find((c) => c.id === req.params.cid);
  if (!clip) {
    res.status(404).json({ detail: 'No such clip' });
    return;
  }
  if (job.status === 'queued' || job.status === 'running' || clip.status === 'queued' || clip.status === 'rendering') {
    res.status(409).json({ detail: 'This clip is still being made. Try again when it has finished.' });
    return;
  }
  try {
    const updated = requestClipRender(uid, req.params.jid, req.params.cid, req.body || {});
    res.json(publicJob(updated));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Invalid render parameters.' });
  }
});

app.delete('/api/jobs/:jid', requireUser, (req: AuthedRequest, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  if (job.status === 'queued' || job.status === 'running' || job.status === 'live') {
    res.status(409).json({ detail: 'This is still being worked on. Stop it or wait for it to finish first.' });
    return;
  }
  removeJob(req.user!.id, req.params.jid);
  res.json({ ok: true });
});

app.delete('/api/jobs/:jid/clips/:cid', requireUser, (req: AuthedRequest, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  const idx = job.clips.findIndex((c) => c.id === req.params.cid);
  if (idx < 0) {
    res.status(404).json({ detail: 'No such clip' });
    return;
  }
  const [removed] = job.clips.splice(idx, 1);
  for (const fname of [removed.file, removed.cover, `${removed.id}.ass`]) {
    if (fname) {
      try {
        fs.rmSync(path.join(job.dir, 'clips', fname), { force: true });
      } catch {
        // ignore
      }
    }
  }
  putJob(job);
  res.json({ ok: true });
});

app.post('/api/bulk/delete', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const videos = Array.isArray(req.body?.videos) ? req.body.videos : [];
  const clips = Array.isArray(req.body?.clips) ? req.body.clips : [];
  let deletedVideos = 0;
  let deletedClips = 0;

  for (const jid of videos.slice(0, 300)) {
    const j = getJob(uid, String(jid));
    if (j && j.status !== 'queued' && j.status !== 'running') {
      removeJob(uid, j.id);
      deletedVideos += 1;
    }
  }
  for (const pair of clips.slice(0, 300)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const j = getJob(uid, String(pair[0]));
    if (!j) continue;
    const idx = j.clips.findIndex((c) => c.id === String(pair[1]));
    if (idx >= 0) {
      const [removed] = j.clips.splice(idx, 1);
      for (const fname of [removed.file, removed.cover]) {
        if (fname) fs.rmSync(path.join(j.dir, 'clips', fname), { force: true });
      }
      putJob(j);
      deletedClips += 1;
    }
  }
  res.json({ ok: true, videos: deletedVideos, clips: deletedClips });
});

app.get('/api/clips.zip', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const ids = String(req.query.ids || '')
    .split(',')
    .map((p) => p.split('.'))
    .filter((p) => p.length === 2)
    .slice(0, 300);

  const files: { abs: string; name: string }[] = [];
  for (const [jid, cid] of ids) {
    const j = getJob(uid, jid);
    const clip = j?.clips.find((c) => c.id === cid && c.file);
    if (!j || !clip?.file) continue;
    const abs = path.join(j.dir, 'clips', clip.file);
    if (fs.existsSync(abs)) {
      const safeTitle = (clip.title || clip.id).replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 50) || clip.id;
      files.push({ abs, name: `${safeTitle}-${clip.id}.mp4` });
    }
  }

  if (files.length === 0) {
    res.status(400).json({ detail: 'No ready clips were selected.' });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="peakcut-clips-${files.length}.zip"`);
  res.setHeader('Cache-Control', 'private, no-store');

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', () => {
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  for (const f of files) {
    archive.file(f.abs, { name: f.name });
  }
  void archive.finalize();
});

app.get('/media/:jid/:name', requireUser, (req: AuthedRequest, res) => {
  const { jid, name } = req.params;
  if (!/^[\w\-]+\.(mp4|jpg)$/.test(name)) {
    res.status(404).end();
    return;
  }
  const job = getJob(req.user!.id, jid);
  if (!job) {
    res.status(404).end();
    return;
  }
  const f = path.join(job.dir, 'clips', name);
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(f);
});

// ================================================================ Creators & Live
function validateCreatorChannels(body: Record<string, unknown>): string | null {
  const ch = String(body.channel || '').trim();
  if (ch && !siteAllowed(ch)) return 'Channel links must be from YouTube, Twitch or Kick.';
  if (body.channels !== undefined && body.channels !== null) {
    if (typeof body.channels !== 'object' || Array.isArray(body.channels)) return 'Bad channel list.';
    for (const [plat, rawUrl] of Object.entries(body.channels as Record<string, unknown>)) {
      const url = String(rawUrl || '').trim();
      if (!url) continue;
      if (platformKey(url) !== plat) return `That link isn't a ${plat[0].toUpperCase() + plat.slice(1)} channel.`;
      if (!siteAllowed(url)) return 'Channel links must be from YouTube, Twitch or Kick.';
    }
  }
  return null;
}

app.get('/api/channel-preview', requireUser, async (req: AuthedRequest, res) => {
  const url = String(req.query.url || '').trim().slice(0, 300);
  if (!url || !siteAllowed(url)) {
    res.status(400).json({ detail: 'Paste a YouTube, Twitch or Kick channel link.' });
    return;
  }
  try {
    const info = await previewChannel(url);
    res.json(info);
  } catch (err) {
    res.status(422).json({ detail: err instanceof Error ? err.message : "Couldn't open that channel." });
  }
});

app.get('/api/creators', requireUser, (req: AuthedRequest, res) => {
  res.json(creatorRows(req.user!.id));
});

app.post('/api/creators', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const chErr = validateCreatorChannels(req.body || {});
  if (chErr) {
    res.status(400).json({ detail: chErr });
    return;
  }
  if (listCreators(uid).length >= MAX_CREATORS) {
    res.status(400).json({ detail: `This server allows ${MAX_CREATORS} creators per account.` });
    return;
  }
  try {
    const c = createCreator(uid, req.body || {});
    res.json({ ...c, live_job: null, log: readCreatorLog(uid, c.id, 30) });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not create creator.' });
  }
});

app.put('/api/creators/:cid', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const chErr = validateCreatorChannels(req.body || {});
  if (chErr) {
    res.status(400).json({ detail: chErr });
    return;
  }
  try {
    const c = updateCreator(uid, req.params.cid, req.body || {});
    res.json({ ...c, live_job: null, log: readCreatorLog(uid, c.id, 30) });
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      res.status(404).json({ detail: 'No such creator' });
      return;
    }
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not save creator.' });
  }
});

app.delete('/api/creators/:cid', requireUser, (req: AuthedRequest, res) => {
  if (!deleteCreator(req.user!.id, req.params.cid)) {
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/creators/:cid/avatar', requireUser, (_req, res) => {
  res.status(404).end();
});

app.post('/api/creators/:cid/live', requireUser, (req: AuthedRequest, res) => {
  const c = getCreator(req.user!.id, req.params.cid);
  if (!c) {
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  res.status(400).json({
    detail:
      'Live stream capture requires yt-dlp and an active stream pipeline not available in this Node.js runtime. Upload a recorded VOD video file to clip with AI and ffmpeg.',
  });
});

app.post('/api/live/:jid/stop', requireUser, (_req, res) => {
  res.status(404).json({ detail: 'This recording has already ended' });
});

app.post('/api/live/:jid/clip', requireUser, (_req, res) => {
  res.status(404).json({ detail: 'This recording has already ended' });
});

// ================================================================ AI Settings & Usage
app.get('/api/usage', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const names = Object.fromEntries(listCreators(uid).map((c) => [c.id, c.name]));
  res.json(usageSummary(uid, names, getAiMeta()));
});

app.get('/api/ai', requireAdmin, (_req, res) => {
  res.json(publicAiConfig());
});

app.put('/api/ai', requireAdmin, (req: AuthedRequest, res) => {
  const body = req.body || {};
  const k = body.key;
  const nextKey =
    k === undefined || k === null || (typeof k === 'string' && !k.trim() && !body.remove_key)
      ? null
      : String(k);
  try {
    const out = saveAiConfig(body.provider, body.models, String(body.base_url || ''), nextKey);
    bump(req.user!.id);
    res.json(out);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Invalid AI settings.' });
  }
});

app.post('/api/ai/models', requireAdmin, async (req: AuthedRequest, res) => {
  if (!throttle('aimodels:' + req.user!.id, 30, 600)) {
    res.status(429).json({ detail: 'Too many requests at once. Wait a moment.' });
    return;
  }
  try {
    const models = await listModels(req.body?.provider, req.body?.base_url, req.body?.key);
    res.json({ models });
  } catch (err) {
    res.status(502).json({ detail: `The service did not give its list of models. ${explainError(err)}` });
  }
});

app.post('/api/ai/test', requireAdmin, async (req: AuthedRequest, res) => {
  if (!throttle('aitest:' + req.user!.id, 20, 600)) {
    res.status(429).json({ detail: 'Too many requests at once. Wait a moment.' });
    return;
  }
  try {
    const result = await testAi();
    res.json(result);
  } catch (err) {
    res.status(502).json({ detail: explainError(err) || 'The AI did not answer.' });
  }
});

// ================================================================ Overview, Settings, Accounts, Posting, Alerts, Storage
app.get('/api/overview', requireUser, (req: AuthedRequest, res) => {
  res.json(getOverview(req.user!.id));
});

app.get('/api/settings', requireUser, (req: AuthedRequest, res) => {
  res.json(publicSettings(req.user!.id));
});

app.put('/api/settings', requireUser, (req: AuthedRequest, res) => {
  try {
    saveSettings(req.user!.id, req.body || {});
    res.json(publicSettings(req.user!.id));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not save settings.' });
  }
});

app.get('/api/accounts', requireUser, (req: AuthedRequest, res) => {
  res.json(listAccounts(req.user!.id));
});

app.delete('/api/accounts/:aid', requireUser, (req: AuthedRequest, res) => {
  removeAccount(req.user!.id, req.params.aid);
  res.json({ ok: true });
});

app.get('/api/apps', requireAdmin, (_req, res) => {
  res.json(appsPublic());
});

app.put('/api/apps', requireAdmin, (req, res) => {
  try {
    res.json(saveApp(String(req.body?.platform || ''), req.body?.client_id, req.body?.client_secret));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not save app.' });
  }
});

app.get('/oauth/:platform/start', requireUser, (req, res) => {
  const plat = req.params.platform;
  if (!(plat in PLATFORM_NAMES)) {
    res.status(404).end();
    return;
  }
  const msg = encodeURIComponent(`Configure ${PLATFORM_NAMES[plat]} OAuth credentials in Settings > Connected apps first.`);
  res.redirect(303, `/app/settings/apps?connect_error=${msg}`);
});

app.get('/oauth/:platform/callback', requireUser, (_req, res) => {
  res.redirect(303, '/app/settings/apps');
});

app.post('/api/posts', requireUser, (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const job = getJob(uid, String(req.body?.job || ''));
  const clipId = String(req.body?.clip || '');
  const clip = job?.clips.find((c) => c.id === clipId);
  if (!job || !clip || clip.status !== 'done') {
    res.status(404).json({ detail: 'That clip is not ready' });
    return;
  }
  const accs = Array.isArray(req.body?.accounts) ? req.body.accounts.map(String) : [];
  const made = enqueuePosts(uid, job, clipId, accs, Boolean(req.body?.now));
  if (!made.length) {
    res.status(400).json({ detail: 'Nothing was queued. Pick at least one account this clip has not already gone to.' });
    return;
  }
  res.json({ queued: made.length });
});

app.post('/api/posts/:pid/:action', requireUser, (req: AuthedRequest, res) => {
  const action = req.params.action;
  if (action !== 'cancel' && action !== 'retry') {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  try {
    postAction(req.user!.id, req.params.pid, action);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Action failed.' });
  }
});

app.post('/api/alerts/test', requireUser, async (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  if (!alertsConfigured(uid)) {
    res.status(400).json({ detail: 'Save a Discord webhook or Telegram details first.' });
    return;
  }
  const s = getSettings(uid);
  const problems: string[] = [];
  if (s.discord_webhook) {
    try {
      const r = await fetch(s.discord_webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'PeakCut: test message. Alerts are working.' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) problems.push(`Discord returned HTTP ${r.status}`);
    } catch {
      problems.push('Could not reach Discord webhook.');
    }
  }
  if (s.telegram_token && s.telegram_chat) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${s.telegram_token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: s.telegram_chat, text: 'PeakCut: test message. Alerts are working.' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) problems.push(`Telegram returned HTTP ${r.status}`);
    } catch {
      problems.push('Could not reach Telegram.');
    }
  }
  if (problems.length) {
    res.status(400).json({ detail: problems.join('; ') });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/storage', requireAdmin, (_req, res) => {
  res.json(storageInfo(false));
});

app.put('/api/storage', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'Storage folder is managed by this cloud container environment.' });
});

app.post('/api/storage/open', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'The folder can only be opened on a local desktop computer.' });
});

app.post('/api/storage/pick', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'Folder picker is only available on a local desktop computer.' });
});

// ================================================================ Notifications & Feedback
app.get('/api/notifications', requireUser, (req: AuthedRequest, res) => {
  res.json(listNotices(req.user!.id));
});

app.post('/api/notifications/read', requireUser, (req: AuthedRequest, res) => {
  markAllNoticesRead(req.user!.id);
  res.json({ ok: true });
});

app.post('/api/feedback', requireUser, (req: AuthedRequest, res) => {
  try {
    res.json(
      submitFeedback(
        req.user!.id,
        String(req.body?.kind || ''),
        String(req.body?.message || ''),
        String(req.body?.page || ''),
        String(req.body?.context || ''),
      ),
    );
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not send feedback.' });
  }
});

// ================================================================ Admin
app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  res.json(adminOverview(getAiMeta()));
});

app.get('/api/admin/users/:uid', requireAdmin, (req, res) => {
  const detail = adminUserDetail(req.params.uid);
  if (!detail) {
    res.status(404).json({ detail: 'No such account' });
    return;
  }
  res.json(detail);
});

app.post('/api/admin/users/:uid/disabled', requireAdmin, (req: AuthedRequest, res) => {
  try {
    setUserDisabled(req.user!.id, req.params.uid, Boolean(req.body?.disabled));
    res.json({ ok: true, disabled: Boolean(req.body?.disabled) });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed to update account.' });
  }
});

app.post('/api/admin/users/:uid/delete', requireAdmin, (req: AuthedRequest, res) => {
  const detail = adminUserDetail(req.params.uid);
  if (!detail) {
    res.status(404).json({ detail: 'No such account' });
    return;
  }
  if (detail.id === req.user!.id) {
    res.status(400).json({ detail: "You can't delete your own account from here." });
    return;
  }
  if (String(req.body?.confirm || '').trim().toLowerCase() !== detail.email.toLowerCase()) {
    res.status(400).json({ detail: "Type the account's email address exactly to confirm." });
    return;
  }
  deleteAccount(detail.id);
  res.json({ ok: true });
});

app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  res.json(listFeedback(String(req.query.status || '')));
});

app.post('/api/admin/feedback/:fid', requireAdmin, (req, res) => {
  try {
    setFeedbackStatus(Number(req.params.fid), String(req.body?.status || ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Invalid status.' });
  }
});

app.get('/api/admin/email-preview', requireAdmin, (_req, res) => {
  res.type('text/html').send('<html><body><p>Email service is not configured in this environment.</p></body></html>');
});

app.post('/api/admin/test-email', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'No email service is set up yet.' });
});

// ================================================================ Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[PeakCut error]', err);
  if (res.headersSent) return;
  res.status(500).json({ detail: 'Something went wrong on the server.' });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  PeakCut is running: http://${HOST}:${PORT}\n`);
});
