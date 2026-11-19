import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();
export const WEB_DIR = path.join(ROOT, 'web');
export const FONTS_DIR = path.join(ROOT, 'fonts');

const envData = (process.env.PEAKCUT_DATA || '').trim();
export const DATA_FROM: 'env' | 'default' = envData ? 'env' : 'default';
export const DATA_DIR = path.resolve(ROOT, envData || './data');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const UPLOADS_DIR = path.join(TMP_DIR, 'uploads');

export const PORT = Number(process.env.PORT || process.env.PEAKCUT_PORT || 3000);
export const HOST = '0.0.0.0';

export const ACCOUNTS = process.env.PEAKCUT_ACCOUNTS === '1';
export const VERIFY_EMAIL = process.env.PEAKCUT_VERIFY_EMAIL === '1';
export const PUBLIC_URL = (
  process.env.PEAKCUT_PUBLIC_URL ||
  process.env.APP_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '');

export const MAX_UPLOAD_MB = Math.max(10, Number(process.env.PEAKCUT_MAX_UPLOAD_MB || 500));
export const UPLOAD_PART_MB = Math.max(1, Number(process.env.PEAKCUT_UPLOAD_PART_MB || 25));
export const MAX_ACTIVE_JOBS_PER_USER = Math.max(1, Number(process.env.PEAKCUT_MAX_JOBS_PER_USER || 5));
export const MAX_CREATORS = Math.max(1, Number(process.env.PEAKCUT_MAX_CREATORS || 25));
export const MAX_USER_GB = Math.max(1, Number(process.env.PEAKCUT_MAX_USER_GB || 10));
export const MIN_FREE_DISK_GB = 0.5;

export const OUT_W = 1080;
export const OUT_H = 1920;
export const OUT_FPS = 30;

export const REPO_URL = 'https://github.com/haziqahmedqasmi/peakcut';
export const FOLLOW_URL = '';

export const LEGAL_NAME = process.env.PEAKCUT_LEGAL_NAME || 'PeakCut';
export const LEGAL_COUNTRY = process.env.PEAKCUT_LEGAL_COUNTRY || '';
export const CONTACT_EMAIL = process.env.PEAKCUT_CONTACT_EMAIL || '';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.ts', '.flv']);

export function ensureDirs(): void {
  for (const d of [DATA_DIR, TMP_DIR, UPLOADS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function userDir(uid: string): string {
  const safeUid = uid.replace(/[^A-Za-z0-9_-]/g, '_') || 'local';
  const dir = path.join(DATA_DIR, 'users', safeUid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let ffmpegChecked: boolean | null = null;
export function hasFfmpeg(): boolean {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 });
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

export function getEnvAiConfig(): {
  provider: string;
  models: string[];
  base_url: string;
  key: string;
} {
  const rawProvider = (process.env.PEAKCUT_AI_PROVIDER || '').trim().toLowerCase();
  const envPeakcutKey = (process.env.PEAKCUT_AI_KEY || '').trim();
  const envGeminiKey = (process.env.GEMINI_API_KEY || '').trim();

  const provider = rawProvider || (envGeminiKey ? 'gemini' : 'gemini');
  const rawModels = (process.env.PEAKCUT_AI_MODELS || '').trim();
  const models = rawModels
    ? rawModels.split(',').map((m) => m.trim()).filter(Boolean)
    : ['gemini-2.5-flash'];
  const base_url = (process.env.PEAKCUT_AI_BASE_URL || '').trim().replace(/\/+$/, '');
  const key = envPeakcutKey || (provider === 'gemini' ? envGeminiKey : '');

  return { provider, models, base_url, key };
}
