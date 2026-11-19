export interface UserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  google_sub: string;
  is_admin: boolean;
  disabled: boolean;
  verified: boolean;
  created_at: number;
  last_seen: number;
}

export interface WordStamp {
  w: string;
  s: number;
  e: number;
}

export interface ClipItem {
  id: string;
  start: number;
  end: number;
  score: number;
  category: string;
  hook: string;
  title: string;
  description: string;
  hashtags: string[];
  highlight_words: string[];
  reason: string;
  style: string;
  layout: string;
  captions: boolean;
  status: 'queued' | 'rendering' | 'done' | 'error';
  file?: string;
  cover?: string;
  version: number;
  made_at: number;
  error?: string | null;
  src?: string;
  src_offset?: number;
  src_end?: number;
  facecam?: number[] | null;
}

export interface JobOptions {
  max_clips: number;
  min_len: number;
  max_len: number;
  style: string;
  layout: string;
  quality: number;
  range_start: number | null;
  range_end: number | null;
  captions: boolean;
}

export interface JobSource {
  type: 'file' | 'url' | 'live';
  name: string;
  url?: string;
  path?: string;
}

export interface JobRecord {
  id: string;
  user: string;
  kind: 'video' | 'live';
  creator: string | null;
  dir: string;
  created: number;
  source: JobSource;
  source_path?: string;
  options: JobOptions;
  status: 'queued' | 'running' | 'done' | 'error' | 'live';
  stage: string;
  progress: number;
  title: string;
  uploader: string;
  duration: number;
  width: number;
  height: number;
  thumb?: boolean;
  clips: ClipItem[];
  words?: WordStamp[];
  error: string | null;
  ai: {
    model?: string;
    tokens?: number;
    note?: string;
  };
}

export interface CreatorProfile {
  channel: string;
  title?: string;
  handle?: string;
  live?: boolean;
  live_at?: number;
  viewers?: number;
  pic?: string;
}

export interface CreatorRecord {
  id: string;
  user: string;
  created: number;
  name: string;
  channel: string;
  channels: Record<string, string>;
  profiles?: Record<string, CreatorProfile>;
  profile?: CreatorProfile;
  style: string;
  layout: string;
  captions: boolean;
  min_len: number;
  max_len: number;
  max_clips: number;
  min_score: number;
  auto_watch: boolean;
  buffer_min: number;
  live_per_hour: number;
  ai_every_min: number;
  ai_only_on_spike: boolean;
  auto_jump_pct: number;
  plan: 'free' | 'pro' | 'max';
  decide_mode: 'both' | 'either';
  must_clip_min: number;
  min_gap_min: number;
  game: string;
  trigger_words: string;
  autopost: boolean;
  accounts: string[];
  post_min_score: number;
  post_gap_min: number;
  daily_cap: number;
  privacy: 'public' | 'unlisted' | 'private';
  post_footer: string;
  rate_per_1k: number;
}

export interface CreatorLogEntry {
  t: number;
  msg: string;
}

export interface UserSettings {
  discord_webhook: string;
  telegram_token: string;
  telegram_chat: string;
  paused: boolean;
  digest_hour: number;
  last_digest: string;
  tour_done: boolean;
}

export interface SocialAccount {
  id: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  name: string;
  added: number;
  detail: string;
}

export interface PostItem {
  id: string;
  user: string;
  creator: string | null;
  job: string;
  clip: string;
  title: string;
  account: string;
  account_name: string;
  platform: string;
  status: 'queued' | 'posting' | 'posted' | 'failed' | 'cancelled';
  due_at: number;
  posted_at: number;
  views: number;
  url: string;
  error: string;
}

export interface UsageEntry {
  t: number;
  user_id: string;
  tokens_in: number;
  tokens_out: number;
  purpose: string;
  place: string;
  creator: string | null;
}

export interface NoticeItem {
  id: number;
  user_id: string;
  t: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  ref?: string;
  read_at: number | null;
}

export interface FeedbackItem {
  id: number;
  user_id: string;
  t: number;
  kind: 'bug' | 'idea' | 'other';
  message: string;
  page: string;
  context: string;
  status: 'new' | 'seen' | 'done';
  updated_at: number;
}

export interface UploadSession {
  id: string;
  user: string;
  name: string;
  ext: string;
  size: number;
  part: number;
  parts: number;
  options: Record<string, unknown>;
  creator: string;
  t: number;
  dir: string;
}
