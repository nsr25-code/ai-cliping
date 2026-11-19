import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeAudioWithGemini, explainError, noteProblem } from './ai.ts';
import { hasFfmpeg, userDir } from './config.ts';
import { extractAudioMp3, extractThumbnail, LAYOUTS, probeVideo, renderClip, STYLES } from './render.ts';
import {
  addNotice,
  getCreator,
  getJob,
  nowSec,
  platformKey,
  putJob,
  recordUsage,
} from './store.ts';
import type { ClipItem, JobOptions, JobRecord, JobSource, WordStamp } from './types.ts';

export const JOB_DEFAULTS: JobOptions = {
  max_clips: 6,
  min_len: 15,
  max_len: 60,
  style: 'bounce',
  layout: 'blur',
  quality: 720,
  range_start: null,
  range_end: null,
  captions: true,
};

const LIMITS: Record<string, [number, number]> = {
  max_clips: [1, 20],
  min_len: [5, 120],
  max_len: [10, 180],
  quality: [360, 1080],
};

export function cleanOptions(options: unknown): Partial<JobOptions> {
  const out: Partial<JobOptions> = {};
  if (!options || typeof options !== 'object') return out;
  for (const [k, raw] of Object.entries(options as Record<string, unknown>)) {
    if (k === 'captions') {
      if (typeof raw !== 'boolean') throw new Error('Captions must be on or off.');
      out.captions = raw;
      continue;
    }
    if (!(k in JOB_DEFAULTS) || raw === '' || raw === null || raw === undefined) continue;
    if (k in LIMITS) {
      const [lo, hi] = LIMITS[k];
      const n = Math.trunc(Number(raw));
      if (!Number.isFinite(n)) throw new Error('Those options aren\'t valid.');
      (out as Record<string, unknown>)[k] = Math.max(lo, Math.min(hi, n));
    } else if (k === 'style') {
      out.style = String(raw) in STYLES ? String(raw) : JOB_DEFAULTS.style;
    } else if (k === 'layout') {
      out.layout = String(raw) in LAYOUTS ? String(raw) : JOB_DEFAULTS.layout;
    } else if (k === 'range_start' || k === 'range_end') {
      const f = Number(raw);
      if (!Number.isFinite(f) || f < 0) throw new Error("That part of the video isn't valid.");
      out[k] = f;
    }
  }
  if (out.range_end !== undefined && out.range_end !== null && out.range_end <= (out.range_start ?? 0)) {
    throw new Error('The end of the chosen part must be after its start.');
  }
  return out;
}

export function publicJob(job: JobRecord) {
  const { dir: _dir, user: _user, source_path: _sp, words: _words, ...rest } = job;
  const { path: _p, ...pubSource } = job.source;
  const pubClips = job.clips.map(({ src: _s, ...c }) => c);
  return {
    ...rest,
    source: pubSource,
    clips: pubClips,
    ai: {
      tokens: job.ai?.tokens || 0,
      note: job.ai?.note || '',
      used: Boolean(job.ai?.model),
    },
  };
}

export function siteAllowed(url: string): boolean {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return Boolean(platformKey(parsed.toString()));
  } catch {
    return false;
  }
}

export async function previewLink(url: string) {
  const platform = platformKey(url);
  if (!platform) throw new Error('Paste a full link to a YouTube, Twitch or Kick video.');
  if (platform === 'youtube') {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      return {
        title: data.title || 'YouTube video',
        uploader: data.author_name || '',
        duration: 0,
        is_live: false,
        thumbnail: data.thumbnail_url || '',
        kind: 'video',
      };
    }
  }
  const parsed = new URL(url);
  return {
    title: `${platform.charAt(0).toUpperCase() + platform.slice(1)} video (${parsed.pathname.replace(/^\/+/, '') || 'link'})`,
    uploader: platform,
    duration: 0,
    is_live: false,
    thumbnail: '',
    kind: 'video',
  };
}

export async function previewChannel(url: string) {
  const normalized = url.includes('://') ? url : `https://${url}`;
  const platform = platformKey(normalized);
  if (!platform) throw new Error('Paste a YouTube, Twitch or Kick channel link.');
  const parsed = new URL(normalized);
  const seg = parsed.pathname.split('/').filter(Boolean).pop() || platform;
  const cleanName = seg.replace(/^@/, '');
  return {
    platform,
    channel: normalized,
    name: cleanName,
    handle: seg.startsWith('@') ? seg : `@${cleanName}`,
    live: false,
    viewers: 0,
  };
}

// Serial worker queue so ffmpeg renders never overwhelm container CPU/RAM
const taskQueue: (() => Promise<void>)[] = [];
let working = false;

function scheduleTask(fn: () => Promise<void>): void {
  taskQueue.push(fn);
  if (!working) {
    working = true;
    void (async () => {
      while (taskQueue.length > 0) {
        const next = taskQueue.shift();
        if (next) {
          try {
            await next();
          } catch (err) {
            console.error('[PeakCut worker]', err);
          }
        }
      }
      working = false;
    })();
  }
}

export function createJob(
  uid: string,
  source: JobSource,
  options: Record<string, unknown>,
  enqueue = true,
  creatorId: string | null = null,
): JobRecord {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const jid = `${stamp}-${crypto.randomBytes(5).toString('hex')}`;

  const creator = creatorId ? getCreator(uid, creatorId) : null;
  const baseDir = creator
    ? path.join(userDir(uid), 'creators', creator.id, 'videos', jid)
    : path.join(userDir(uid), 'jobs', jid);
  fs.mkdirSync(baseDir, { recursive: true });

  const baseOpts: JobOptions = creator
    ? {
        ...JOB_DEFAULTS,
        max_clips: creator.max_clips,
        min_len: creator.min_len,
        max_len: creator.max_len,
        style: creator.style,
        layout: creator.layout,
        captions: creator.captions,
      }
    : { ...JOB_DEFAULTS };

  const opts: JobOptions = { ...baseOpts, ...cleanOptions(options) };
  if (opts.min_len >= opts.max_len) {
    opts.min_len = Math.max(5, opts.max_len - 5);
  }

  const job: JobRecord = {
    id: jid,
    user: uid,
    kind: 'video',
    creator: creator ? creator.id : null,
    dir: baseDir,
    created: nowSec(),
    source,
    source_path: source.path,
    options: opts,
    status: 'queued',
    stage: 'Waiting',
    progress: 0,
    title: source.name || 'Video',
    uploader: '',
    duration: 0,
    width: 1920,
    height: 1080,
    clips: [],
    words: [],
    error: null,
    ai: {},
  };

  putJob(job);
  if (enqueue) {
    enqueueJob(job);
  }
  return job;
}

export function enqueueJob(job: JobRecord): void {
  putJob(job);
  scheduleTask(() => runJob(job));
}

function buildFallbackClips(
  duration: number,
  rangeStart: number,
  rangeEnd: number,
  opts: JobOptions,
  title: string,
): ClipItem[] {
  const span = Math.max(3, rangeEnd - rangeStart);
  const targetLen = Math.min(opts.max_len, Math.max(Math.min(opts.min_len, span), Math.min(25, span)));
  const count = Math.max(1, Math.min(opts.max_clips, Math.floor(span / Math.max(targetLen, 8)) || 1));
  const step = span / count;
  const clips: ClipItem[] = [];
  for (let i = 0; i < count; i++) {
    const s = Number((rangeStart + i * step).toFixed(2));
    const e = Number(Math.min(rangeEnd, Math.max(s + 3, s + targetLen)).toFixed(2));
    if (e - s < 3) continue;
    clips.push({
      id: `clip-${String(i + 1).padStart(2, '0')}`,
      start: s,
      end: e,
      score: Math.max(68, 86 - i * 4),
      category: 'other',
      hook: i === 0 ? 'BEST MOMENT' : `HIGHLIGHT #${i + 1}`,
      title: `${title.replace(/\.[^.]+$/, '').slice(0, 50)} — Clip ${i + 1}`,
      description: `Clip from ${Math.floor(s)}s to ${Math.floor(e)}s.`,
      hashtags: ['shorts', 'clips', 'highlights'],
      highlight_words: [],
      reason: 'Selected by timeline segmentation.',
      style: opts.style,
      layout: opts.layout,
      captions: opts.captions,
      status: 'queued',
      version: 0,
      made_at: nowSec(),
      error: null,
    });
  }
  return clips;
}

async function runJob(job: JobRecord): Promise<void> {
  try {
    job.status = 'running';
    job.error = null;

    if (job.source.type === 'url') {
      job.status = 'error';
      job.stage = 'Upload a video file';
      job.error =
        'Direct YouTube/Twitch/Kick downloading requires yt-dlp, which is not available in this Node.js runtime. Drop or choose a local video file (.mp4, .mov, .mkv, .webm) to run the full AI clipping & ffmpeg rendering pipeline.';
      putJob(job);
      return;
    }

    if (!hasFfmpeg()) {
      job.status = 'error';
      job.stage = 'ffmpeg not installed';
      job.error = 'ffmpeg is required to process videos.';
      putJob(job);
      return;
    }

    const srcPath = job.source_path || job.source.path || '';
    if (!srcPath || !fs.existsSync(srcPath)) {
      throw new Error('Uploaded video file could not be found.');
    }

    job.stage = 'Inspecting video';
    job.progress = 0.08;
    putJob(job);

    const probe = await probeVideo(srcPath);
    job.duration = probe.duration;
    job.width = probe.width;
    job.height = probe.height;

    const thumbPath = path.join(job.dir, 'clips', 'thumb.jpg');
    if (await extractThumbnail(srcPath, thumbPath, Math.min(2, probe.duration / 3))) {
      job.thumb = true;
    }
    putJob(job);

    const rangeStart = Math.max(0, Math.min(probe.duration - 3, job.options.range_start ?? 0));
    const rangeEnd = Math.max(rangeStart + 3, Math.min(probe.duration, job.options.range_end ?? probe.duration));

    let words: WordStamp[] = [];
    let pickedClips: ClipItem[] = [];

    if (probe.hasAudio) {
      job.stage = 'Extracting audio';
      job.progress = 0.2;
      putJob(job);

      const audioPath = path.join(job.dir, 'audio.mp3');
      const hasMp3 = await extractAudioMp3(srcPath, audioPath);

      if (hasMp3) {
        job.stage = 'AI is finding the best moments';
        job.progress = 0.35;
        putJob(job);

        try {
          const scouted = await analyzeAudioWithGemini({
            audioPath,
            title: job.title,
            uploader: job.uploader,
            duration: probe.duration,
            maxClips: job.options.max_clips,
            minLen: job.options.min_len,
            maxLen: job.options.max_len,
            rangeStart,
            rangeEnd,
          });

          if (scouted) {
            words = scouted.words;
            job.words = words;
            const totalTok = scouted.tokensIn + scouted.tokensOut;
            job.ai = { model: scouted.model, tokens: totalTok, note: '' };
            recordUsage(job.user, scouted.tokensIn, scouted.tokensOut, 'clip_scout', job.title, job.creator);

            pickedClips = scouted.clips.map((c, idx) => ({
              id: `clip-${String(idx + 1).padStart(2, '0')}`,
              start: c.start,
              end: c.end,
              score: c.score,
              category: c.category,
              hook: c.hook,
              title: c.title,
              description: c.description,
              hashtags: c.hashtags,
              highlight_words: c.highlight_words,
              reason: c.reason,
              style: job.options.style,
              layout: job.options.layout,
              captions: job.options.captions,
              status: 'queued',
              version: 0,
              made_at: nowSec(),
              error: null,
            }));
          }
        } catch (aiErr) {
          noteProblem(aiErr);
          job.ai = { note: explainError(aiErr), tokens: 0 };
        }
      }
    }

    if (pickedClips.length === 0) {
      pickedClips = buildFallbackClips(probe.duration, rangeStart, rangeEnd, job.options, job.title);
      if (!job.ai.note) {
        job.ai.note = 'Used automatic timeline clips.';
      }
    }

    job.clips = pickedClips;
    job.stage = `Rendering ${pickedClips.length} clip${pickedClips.length === 1 ? '' : 's'}`;
    job.progress = 0.5;
    putJob(job);

    const outDir = path.join(job.dir, 'clips');
    for (let i = 0; i < job.clips.length; i++) {
      const clip = job.clips[i];
      clip.status = 'rendering';
      job.stage = `Rendering clip ${i + 1} of ${job.clips.length}`;
      job.progress = 0.5 + (0.48 * i) / Math.max(1, job.clips.length);
      putJob(job);

      try {
        const rendered = await renderClip({
          srcPath,
          outDir,
          name: clip.id,
          clip,
          words,
          srcW: job.width,
          srcH: job.height,
          hasAudio: probe.hasAudio,
        });
        clip.file = rendered.file;
        clip.cover = rendered.cover;
        clip.layout = rendered.layout;
        clip.status = 'done';
        clip.version = (clip.version || 0) + 1;
        clip.made_at = nowSec();
        clip.error = null;
      } catch (renderErr) {
        clip.status = 'error';
        clip.error = renderErr instanceof Error ? renderErr.message.slice(0, 300) : String(renderErr);
      }
      putJob(job);
    }

    const doneCount = job.clips.filter((c) => c.status === 'done').length;
    job.status = doneCount > 0 ? 'done' : 'error';
    job.stage = doneCount > 0 ? `Done (${doneCount} clip${doneCount === 1 ? '' : 's'})` : 'No clips could be rendered';
    job.progress = 1;
    if (doneCount === 0 && !job.error) {
      job.error = job.clips[0]?.error || 'Clip rendering failed.';
    }
    putJob(job);

    if (doneCount > 0) {
      addNotice(
        job.user,
        'clips',
        `${doneCount} clip${doneCount === 1 ? '' : 's'} ready`,
        job.title,
        `/app/videos/${job.id}`,
        `job-done:${job.id}`,
      );
    }
  } catch (err) {
    job.status = 'error';
    job.stage = 'Failed';
    job.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
    putJob(job);
  }
}

export function requestClipRender(uid: string, jid: string, cid: string, changes: Record<string, unknown>): JobRecord {
  const job = getJob(uid, jid);
  if (!job) throw new Error('No such video');
  const clip = job.clips.find((c) => c.id === cid);
  if (!clip) throw new Error('No such clip');

  if ('captions' in changes) {
    if (typeof changes.captions !== 'boolean') throw new Error('Captions must be on or off.');
    clip.captions = changes.captions;
  }
  if ('start' in changes) clip.start = Number(Number(changes.start).toFixed(2));
  if ('end' in changes) clip.end = Number(Number(changes.end).toFixed(2));

  if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0) {
    throw new Error("Those times aren't valid.");
  }
  if (clip.end - clip.start < 3 || clip.end - clip.start > 180) {
    throw new Error('A clip can be 3 to 180 seconds long.');
  }
  if ('hook' in changes) clip.hook = String(changes.hook || '').slice(0, 60);
  if ('title' in changes) clip.title = String(changes.title || '').slice(0, 100);
  if ('description' in changes) clip.description = String(changes.description || '').slice(0, 2000);
  if ('style' in changes) {
    const s = String(changes.style || '');
    clip.style = s in STYLES ? s : JOB_DEFAULTS.style;
  }
  if ('layout' in changes) {
    const l = String(changes.layout || '');
    clip.layout = l in LAYOUTS ? l : JOB_DEFAULTS.layout;
  }

  clip.status = 'queued';
  clip.error = null;
  putJob(job);

  scheduleTask(async () => {
    clip.status = 'rendering';
    putJob(job);
    try {
      const srcPath = job.source_path || job.source.path || '';
      if (!srcPath || !fs.existsSync(srcPath)) throw new Error('Original video file is no longer available.');
      const probe = await probeVideo(srcPath);
      const rendered = await renderClip({
        srcPath,
        outDir: path.join(job.dir, 'clips'),
        name: clip.id,
        clip,
        words: job.words || [],
        srcW: job.width || probe.width,
        srcH: job.height || probe.height,
        hasAudio: probe.hasAudio,
      });
      clip.file = rendered.file;
      clip.cover = rendered.cover;
      clip.layout = rendered.layout;
      clip.status = 'done';
      clip.version = (clip.version || 0) + 1;
      clip.made_at = nowSec();
      clip.error = null;
    } catch (err) {
      clip.status = 'error';
      clip.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    putJob(job);
  });

  return job;
}
