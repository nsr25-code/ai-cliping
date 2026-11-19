import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FONTS_DIR, OUT_FPS, OUT_H, OUT_W } from './config.ts';
import type { ClipItem, WordStamp } from './types.ts';

const execFileAsync = promisify(execFile);

export const STYLES: Record<
  string,
  {
    label: string;
    font: string;
    size: number;
    base: string;
    active: string;
    strong: string;
    outline: number;
    pop: number;
    upper: boolean;
    per: number;
  }
> = {
  bounce: {
    label: 'Bounce',
    font: 'Poppins ExtraBold',
    size: 132,
    base: 'FFFFFF',
    active: '00F0FF',
    strong: 'FFFFFF',
    outline: 7,
    pop: 112,
    upper: true,
    per: 3,
  },
  hype: {
    label: 'Hype',
    font: 'Anton',
    size: 152,
    base: 'FFFFFF',
    active: '3C3CFF',
    strong: '00D7FF',
    outline: 7,
    pop: 114,
    upper: true,
    per: 2,
  },
  clean: {
    label: 'Clean',
    font: 'Poppins ExtraBold',
    size: 100,
    base: 'FFFFFF',
    active: '6BD7FF',
    strong: 'FFFFFF',
    outline: 5,
    pop: 106,
    upper: false,
    per: 4,
  },
};

export const LAYOUTS: Record<string, string> = {
  blur: 'Full frame + blurred fill',
  zoom: 'Zoomed in + blurred fill',
  crop: 'Fill the screen (centre crop)',
  gameplay: 'Gameplay fills the screen, facecam in the corner',
};

const W = OUT_W;
const H = OUT_H;

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    { timeout: 30000 },
  );
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  };
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('That file does not contain a video stream.');
  const dur = Number(info.format?.duration || v.duration || 0);
  return {
    duration: Number.isFinite(dur) && dur > 0 ? dur : 10,
    width: v.width || 1920,
    height: v.height || 1080,
    hasAudio: Boolean(a),
  };
}

export async function extractThumbnail(srcPath: string, destPath: string, atSec = 1.0): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-ss', String(Math.max(0, atSec)), '-i', srcPath, '-frames:v', '1', '-q:v', '4', destPath],
      { timeout: 30000 },
    );
    return fs.existsSync(destPath);
  } catch {
    return false;
  }
}

export async function extractAudioMp3(srcPath: string, destPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', destPath],
      { timeout: 120000 },
    );
    return fs.existsSync(destPath);
  } catch {
    return false;
  }
}

function assTime(t: number): string {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = (clamped % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

function cleanAss(text: string): string {
  return String(text || '')
    .replace(/[{}\\]/g, '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim();
}

function geometry(srcW: number, srcH: number, layout: string) {
  let l = layout in LAYOUTS ? layout : 'blur';
  if (srcH >= srcW * 1.3) l = 'crop';
  const fgH = l === 'zoom' ? Math.round((H * 0.56) / 2) * 2 : Math.round(((W * srcH) / Math.max(1, srcW)) / 2) * 2;
  if (l === 'crop' || l === 'gameplay') {
    return { layout: l, fgH: H, hookY: 220, capY: Math.round(H * 0.72) };
  }
  const top = Math.round((H - fgH) / 2);
  const bot = top + fgH;
  return {
    layout: l,
    fgH,
    hookY: Math.max(110, Math.round(top * 0.54)),
    capY: Math.min(H - 180, Math.round(bot + (H - bot) * 0.42)),
  };
}

function buildAss(
  words: WordStamp[],
  start: number,
  end: number,
  hook: string,
  styleName: string,
  highlightWords: string[],
  hookY: number,
  capY: number,
): string {
  const st = STYLES[styleName] || STYLES.bounce;
  const strong = new Set(highlightWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')));

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${st.font},${st.size},&H00${st.base},&H00${st.base},&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,${st.outline},2,5,40,40,20,1
Style: Hook,Poppins ExtraBold,82,&H0014100E,&H0014100E,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,22,0,5,60,60,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  const dur = Math.max(0.5, end - start);
  const hookClean = cleanAss(hook).toUpperCase();
  if (hookClean) {
    const hookDur = Math.min(dur, 4.5);
    events.push(
      `Dialogue: 3,${assTime(0)},${assTime(hookDur)},Hook,,60,60,0,,{\\an5\\pos(${Math.round(W / 2)},${hookY})\\fad(120,250)}${hookClean}`,
    );
  }

  const inside = words.filter((w) => w.e > start && w.s < end && cleanAss(w.w));
  const groups: WordStamp[][] = [];
  for (let i = 0; i < inside.length; i += st.per) {
    groups.push(inside.slice(i, i + st.per));
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const gStart = Math.max(0, g[0].s - start);
    const nextStart = gi + 1 < groups.length ? groups[gi + 1][0].s : end;
    const gEnd = Math.min(g[g.length - 1].e + 0.25, nextStart) - start;
    if (gEnd - gStart < 0.04) continue;

    for (let i = 0; i < g.length; i++) {
      const a = Math.max(gStart, g[i].s - start);
      const b = i + 1 < g.length ? Math.max(a + 0.04, g[i + 1].s - start) : gEnd;
      if (b - a < 0.03) continue;
      const line = g
        .map((w, idx) => {
          const txt = cleanAss(w.w).replace(/[.,;:]+$/, '');
          const shown = st.upper ? txt.toUpperCase() : txt;
          const k = txt.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (idx === i) {
            return `{\\c&H${st.active}&\\fscx${st.pop}\\fscy${st.pop}}${shown}{\\r}`;
          }
          const col = strong.has(k) ? st.strong : st.base;
          return `{\\c&H${col}&}${shown}`;
        })
        .join(' ');
      events.push(
        `Dialogue: 2,${assTime(a)},${assTime(b)},Cap,,60,60,0,,{\\an5\\pos(${Math.round(W / 2)},${capY})}${line}`,
      );
    }
  }

  return header + events.join('\n') + '\n';
}

function buildFilter(layout: string, fgH: number): string {
  if (layout === 'crop' || layout === 'gameplay') {
    return `[0:v]fps=${OUT_FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v0];`;
  }
  return (
    `[0:v]fps=${OUT_FPS},split=2[a][b];` +
    `[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,` +
    `scale=${W}:${H},eq=brightness=-0.14:saturation=1.15[bg];` +
    `[b]scale=${W}:${fgH}:force_original_aspect_ratio=increase,crop=${W}:${fgH}[fg];` +
    `[bg][fg]overlay=0:(H-h)/2,setsar=1[v0];`
  );
}

export async function renderClip(params: {
  srcPath: string;
  outDir: string;
  name: string;
  clip: ClipItem;
  words: WordStamp[];
  srcW: number;
  srcH: number;
  hasAudio: boolean;
}): Promise<{ file: string; cover: string; layout: string }> {
  const { srcPath, outDir, name, clip, words, srcW, srcH, hasAudio } = params;
  fs.mkdirSync(outDir, { recursive: true });

  const geom = geometry(srcW, srcH, clip.layout || 'blur');
  const effectiveLayout = geom.layout === 'gameplay' ? 'crop' : geom.layout;
  const assText = buildAss(
    clip.captions ? words : [],
    clip.start,
    clip.end,
    clip.hook || '',
    clip.style || 'bounce',
    clip.highlight_words || [],
    geom.hookY,
    geom.capY,
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-'));
  try {
    const assFile = path.join(workDir, `${name}.ass`);
    fs.writeFileSync(assFile, assText, 'utf-8');

    const fontWork = path.join(workDir, 'f');
    fs.mkdirSync(fontWork, { recursive: true });
    if (fs.existsSync(FONTS_DIR)) {
      for (const f of fs.readdirSync(FONTS_DIR)) {
        if (f.endsWith('.ttf')) {
          fs.copyFileSync(path.join(FONTS_DIR, f), path.join(fontWork, f));
        }
      }
    }

    const dur = Math.max(1, clip.end - clip.start);
    const fc = `${buildFilter(effectiveLayout, geom.fgH)}[v0]ass=${name}.ass:fontsdir=f[v]`;
    const args = [
      '-y',
      '-v',
      'error',
      '-ss',
      clip.start.toFixed(2),
      '-t',
      dur.toFixed(2),
      '-i',
      srcPath,
      '-filter_complex',
      fc,
      '-map',
      '[v]',
    ];
    if (hasAudio) {
      args.push('-map', '0:a:0', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '22', '-preset', 'veryfast', `${name}.mp4`);

    await execFileAsync('ffmpeg', args, { cwd: workDir, timeout: 300000 });

    const coverT = Math.min(1.2, dur / 2);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-ss', coverT.toFixed(2), '-i', `${name}.mp4`, '-frames:v', '1', '-q:v', '3', `${name}.jpg`],
      { cwd: workDir, timeout: 30000 },
    );

    for (const ext of ['mp4', 'jpg', 'ass']) {
      const from = path.join(workDir, `${name}.${ext}`);
      const to = path.join(outDir, `${name}.${ext}`);
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, to);
      }
    }

    return { file: `${name}.mp4`, cover: `${name}.jpg`, layout: effectiveLayout };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
