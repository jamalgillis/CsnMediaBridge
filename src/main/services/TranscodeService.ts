import { copyFile, mkdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import {
  clamp,
  detectPipelineError,
  isHardwareAccelerationFailure,
  parseTimemarkToSeconds,
} from '../lib/helpers';
import {
  getSoftwareEncoderRuntime,
  resolveEncoderRuntime,
  type EncoderRuntimeConfig,
} from '../lib/encoder';
import { sortStoredVideoSources } from '../../shared/media';
import type {
  AppSettings,
  DeliveryType,
  EffectiveHardwareEncoder,
  LogLevel,
  StoredVideoSource,
} from '../../shared/types';

interface TranscodeLogger {
  (level: LogLevel, message: string, jobId?: string): void;
}

interface TranscodeTask {
  jobId: string;
  sourcePath: string;
  outputDirectory: string;
  deliveryType: DeliveryType;
  settings: AppSettings;
  probe?: SourceProbe;
  onProgress: (progress: number) => void;
  onLog: (message: string) => void;
}

interface TrimClipTask {
  sourcePath: string;
  outputPath: string;
  inPointSeconds: number;
  outPointSeconds: number;
  settings: AppSettings;
  onLog: (message: string) => void;
}

interface ProbeStream {
  codec_type?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  width?: number;
  height?: number;
}

interface ProbeFormat {
  duration?: number | string;
}

interface ProbeMetadata {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

export interface SourceProbe {
  durationSeconds: number;
  hasAudio: boolean;
  frameRate: number;
  width: number | null;
  height: number | null;
}

interface PackagedSourceDescriptor {
  codec: StoredVideoSource['codec'];
  mimeType: string;
  relativePath: string;
}

export interface PackagedVideoResult {
  deliveryType: DeliveryType;
  durationSeconds: number;
  frameRate: number;
  width: number | null;
  height: number | null;
  posterPath: string | null;
  masterPlaylistPath: string | null;
  manifestRelativePath: string | null;
  playbackRelativePath: string;
  sources: PackagedSourceDescriptor[];
  effectiveEncoder: EffectiveHardwareEncoder;
}

export interface TrimClipResult {
  durationSeconds: number;
  effectiveEncoder: EffectiveHardwareEncoder;
}

interface HlsVariantDefinition {
  label: string;
  width: number;
  height: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
}

const HLS_SEGMENT_DURATION_SECONDS = 4;
const PROGRESSIVE_H264_FILENAME = 'playback-h264.mp4';
const PROGRESSIVE_AV1_FILENAME = 'playback-av1.webm';
const HLS_VARIANTS: HlsVariantDefinition[] = [
  {
    label: '1080',
    width: 1920,
    height: 1080,
    bitrate: '6000k',
    maxrate: '6420k',
    bufsize: '9000k',
  },
  {
    label: '720',
    width: 1280,
    height: 720,
    bitrate: '3200k',
    maxrate: '3424k',
    bufsize: '4800k',
  },
  {
    label: '480',
    width: 854,
    height: 480,
    bitrate: '1600k',
    maxrate: '1712k',
    bufsize: '2400k',
  },
  {
    label: '360',
    width: 640,
    height: 360,
    bitrate: '850k',
    maxrate: '910k',
    bufsize: '1275k',
  },
];

function parseFrameRate(rate: string | undefined) {
  if (!rate || rate === '0/0') {
    return 0;
  }

  const [numeratorValue, denominatorValue] = rate.split('/');
  const numerator = Number(numeratorValue);
  const denominator = Number(denominatorValue ?? 1);
  if (
    Number.isNaN(numerator) ||
    Number.isNaN(denominator) ||
    denominator === 0
  ) {
    return 0;
  }

  return Number((numerator / denominator).toFixed(3));
}

function probeSource(sourcePath: string) {
  return new Promise<SourceProbe>((resolve, reject) => {
    ffmpeg.ffprobe(sourcePath, (error: Error | null, metadata: ProbeMetadata) => {
      if (error) {
        reject(error);
        return;
      }

      const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
      const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
      const videoStream = streams.find((stream) => stream.codec_type === 'video');

      resolve({
        durationSeconds: Number(metadata.format?.duration ?? 0),
        hasAudio,
        frameRate: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
        width: typeof videoStream?.width === 'number' ? videoStream.width : null,
        height: typeof videoStream?.height === 'number' ? videoStream.height : null,
      });
    });
  });
}

function getTrimOutputOptions(runtime: EncoderRuntimeConfig) {
  if (runtime.effectiveEncoder === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21', '-b:v', '0'];
  }

  if (runtime.effectiveEncoder === 'videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-b:v', '8M'];
  }

  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
}

function getHlsCodecOptions(runtime: EncoderRuntimeConfig) {
  if (runtime.effectiveEncoder === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5'];
  }

  if (runtime.effectiveEncoder === 'videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-realtime', 'true'];
  }

  return ['-c:v', 'libx264', '-preset', 'medium'];
}

function getProgressiveMp4OutputOptions(runtime: EncoderRuntimeConfig) {
  if (runtime.effectiveEncoder === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21', '-b:v', '0'];
  }

  if (runtime.effectiveEncoder === 'videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-b:v', '8M'];
  }

  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21'];
}

function getAv1Attempts() {
  return [
    {
      label: 'libsvtav1',
      outputOptions: [
        '-c:v',
        'libsvtav1',
        '-preset',
        '8',
        '-crf',
        '34',
        '-pix_fmt',
        'yuv420p',
      ],
    },
    {
      label: 'libaom-av1',
      outputOptions: [
        '-c:v',
        'libaom-av1',
        '-cpu-used',
        '6',
        '-row-mt',
        '1',
        '-crf',
        '34',
        '-b:v',
        '0',
        '-pix_fmt',
        'yuv420p',
      ],
    },
  ];
}

function buildProgressiveScaleFilter() {
  return 'scale=w=1920:h=1080:force_original_aspect_ratio=decrease';
}

function buildHlsScaleFilters() {
  return [
    `[0:v]split=${HLS_VARIANTS.length}${HLS_VARIANTS.map((variant) => `[v${variant.label}src]`).join('')}`,
    ...HLS_VARIANTS.map(
      (variant) =>
        `[v${variant.label}src]scale=w=${variant.width}:h=${variant.height}:force_original_aspect_ratio=decrease,pad=${variant.width}:${variant.height}:(ow-iw)/2:(oh-ih)/2:color=black[v${variant.label}]`,
    ),
  ];
}

function getHlsKeyframeInterval(frameRate: number) {
  const normalizedFrameRate = frameRate > 0 ? frameRate : 30;
  return Math.max(24, Math.round(normalizedFrameRate * HLS_SEGMENT_DURATION_SECONDS));
}

export class TranscodeService {
  private queue = Promise.resolve();
  private waitingCount = 0;
  private activeJobId: string | null = null;

  constructor(
    private readonly log: TranscodeLogger,
    private readonly onQueueChange: (queueDepth: number, activeJobId: string | null) => void,
  ) {
    ffmpeg.setFfmpegPath('ffmpeg');
    ffmpeg.setFfprobePath('ffprobe');
  }

  getQueueDepth() {
    return this.waitingCount + (this.activeJobId ? 1 : 0);
  }

  getActiveJobId() {
    return this.activeJobId;
  }

  async inspectSource(sourcePath: string) {
    return await probeSource(sourcePath);
  }

  enqueue(task: TranscodeTask) {
    this.waitingCount += 1;
    this.emitQueueChange();

    return new Promise<PackagedVideoResult>((resolve, reject) => {
      const execute = async () => {
        this.waitingCount = Math.max(0, this.waitingCount - 1);
        this.activeJobId = task.jobId;
        this.emitQueueChange();

        try {
          resolve(await this.runTask(task));
        } catch (error) {
          reject(error);
        } finally {
          this.activeJobId = null;
          this.emitQueueChange();
        }
      };

      this.queue = this.queue.then(execute, execute);
    });
  }

  async trimClip(task: TrimClipTask): Promise<TrimClipResult> {
    const preferredRuntime = resolveEncoderRuntime(task.settings);

    try {
      return await this.executeTrim(task, preferredRuntime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !task.settings.autoFallbackToSoftware ||
        preferredRuntime.effectiveEncoder === 'software' ||
        !isHardwareAccelerationFailure(message)
      ) {
        throw error;
      }

      task.onLog(
        `Hardware trim export failed with ${preferredRuntime.effectiveEncoder}. Retrying with software libx264.`,
      );
      return await this.executeTrim(task, getSoftwareEncoderRuntime());
    }
  }

  private emitQueueChange() {
    this.onQueueChange(this.getQueueDepth(), this.activeJobId);
  }

  private async runTask(task: TranscodeTask): Promise<PackagedVideoResult> {
    const probe = task.probe ?? (await probeSource(task.sourcePath));
    const preferredRuntime = resolveEncoderRuntime(task.settings);

    if (task.deliveryType === 'progressive') {
      try {
        return await this.executeProgressiveTranscode(task, probe, preferredRuntime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !task.settings.autoFallbackToSoftware ||
          preferredRuntime.effectiveEncoder === 'software' ||
          !isHardwareAccelerationFailure(message)
        ) {
          throw error;
        }

        task.onLog(
          `Hardware progressive encode failed with ${preferredRuntime.effectiveEncoder}. Retrying with software libx264.`,
        );
        this.log(
          'warn',
          `Falling back from ${preferredRuntime.effectiveEncoder} to software progressive encoding.`,
          task.jobId,
        );
        return await this.executeProgressiveTranscode(task, probe, getSoftwareEncoderRuntime());
      }
    }

    try {
      return await this.executeHlsTranscode(task, probe, preferredRuntime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !task.settings.autoFallbackToSoftware ||
        preferredRuntime.effectiveEncoder === 'software' ||
        !isHardwareAccelerationFailure(message)
      ) {
        throw error;
      }

      task.onLog(
        `Hardware HLS transcode failed with ${preferredRuntime.effectiveEncoder}. Retrying with software libx264.`,
      );
      this.log(
        'warn',
        `Falling back from ${preferredRuntime.effectiveEncoder} to software HLS encoding.`,
        task.jobId,
      );
      return await this.executeHlsTranscode(task, probe, getSoftwareEncoderRuntime());
    }
  }

  private async executeTrim(
    task: TrimClipTask,
    runtime: EncoderRuntimeConfig,
  ): Promise<TrimClipResult> {
    const clipDurationSeconds = Number((task.outPointSeconds - task.inPointSeconds).toFixed(3));

    await mkdir(path.dirname(task.outputPath), { recursive: true });
    await unlink(task.outputPath).catch(() => undefined);

    task.onLog(`Exporting MP4 trim with ${runtime.effectiveEncoder}.`);

    const command = ffmpeg(task.sourcePath)
      .inputOptions(runtime.inputOptions)
      .output(task.outputPath)
      .seek(task.inPointSeconds)
      .duration(clipDurationSeconds)
      .outputOptions(
        ...getTrimOutputOptions(runtime),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
      );

    await this.runFfmpegCommand({
      command,
      durationSeconds: clipDurationSeconds,
      onLog: task.onLog,
    });

    return {
      durationSeconds: clipDurationSeconds,
      effectiveEncoder: runtime.effectiveEncoder,
    };
  }

  private async executeHlsTranscode(
    task: TranscodeTask,
    probe: SourceProbe,
    runtime: EncoderRuntimeConfig,
  ): Promise<PackagedVideoResult> {
    await rm(task.outputDirectory, { recursive: true, force: true });
    for (const [index] of HLS_VARIANTS.entries()) {
      await mkdir(path.join(task.outputDirectory, String(index)), { recursive: true });
    }

    const masterPlaylistPath = path.join(task.outputDirectory, 'master.m3u8');
    const legacyMasterPlaylistPath = path.resolve(process.cwd(), 'master.m3u8');
    const outputPlaylistPattern = path.join(task.outputDirectory, '%v', 'index.m3u8');
    const keyframeInterval = getHlsKeyframeInterval(probe.frameRate);
    let commandStartedAt = Date.now();

    await unlink(legacyMasterPlaylistPath).catch(() => undefined);

    task.onLog(`Using ${runtime.effectiveEncoder} encoder profile for HLS packaging.`);
    this.log('info', `Queued HLS FFmpeg command with ${runtime.effectiveEncoder}.`, task.jobId);

    const outputOptions = [
      ...HLS_VARIANTS.flatMap((variant) => [
        '-map',
        `[v${variant.label}]`,
        ...(probe.hasAudio ? ['-map', '0:a:0?'] : []),
      ]),
      '-g',
      String(keyframeInterval),
      '-keyint_min',
      String(keyframeInterval),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION_SECONDS})`,
      '-pix_fmt',
      'yuv420p',
      ...getHlsCodecOptions(runtime),
      ...HLS_VARIANTS.flatMap((variant, index) => [
        `-b:v:${index}`,
        variant.bitrate,
        `-maxrate:v:${index}`,
        variant.maxrate,
        `-bufsize:v:${index}`,
        variant.bufsize,
      ]),
      ...(probe.hasAudio
        ? ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k']
        : []),
      '-f',
      'hls',
      '-hls_time',
      String(HLS_SEGMENT_DURATION_SECONDS),
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-master_pl_name',
      'master.m3u8',
      '-var_stream_map',
      probe.hasAudio
        ? HLS_VARIANTS.map((_, index) => `v:${index},a:${index}`).join(' ')
        : HLS_VARIANTS.map((_, index) => `v:${index}`).join(' '),
      '-hls_segment_filename',
      path.join(task.outputDirectory, '%v', 'segment_%03d.m4s'),
    ];

    const command = ffmpeg(task.sourcePath)
      .inputOptions(runtime.inputOptions)
      .complexFilter(buildHlsScaleFilters())
      .output(outputPlaylistPattern)
      .outputOptions(...outputOptions);

    await this.runFfmpegCommand({
      command,
      durationSeconds: probe.durationSeconds,
      onLog: task.onLog,
      onProgress: task.onProgress,
      onStart: () => {
        commandStartedAt = Date.now();
      },
    });

    await this.ensureMasterPlaylistPath(
      masterPlaylistPath,
      legacyMasterPlaylistPath,
      commandStartedAt,
    );

    const posterPath = task.settings.extractPosterFrame
      ? await this.extractPoster(task, probe.durationSeconds)
      : null;

    task.onProgress(100);
    return {
      deliveryType: 'hls',
      durationSeconds: probe.durationSeconds,
      frameRate: probe.frameRate,
      width: probe.width,
      height: probe.height,
      posterPath,
      masterPlaylistPath,
      manifestRelativePath: 'master.m3u8',
      playbackRelativePath: 'master.m3u8',
      sources: [],
      effectiveEncoder: runtime.effectiveEncoder,
    };
  }

  private async executeProgressiveTranscode(
    task: TranscodeTask,
    probe: SourceProbe,
    runtime: EncoderRuntimeConfig,
  ): Promise<PackagedVideoResult> {
    await rm(task.outputDirectory, { recursive: true, force: true });
    await mkdir(task.outputDirectory, { recursive: true });

    const progressiveScaleFilter = buildProgressiveScaleFilter();
    const primaryPlaybackPath = path.join(task.outputDirectory, PROGRESSIVE_H264_FILENAME);
    const av1PlaybackPath = path.join(task.outputDirectory, PROGRESSIVE_AV1_FILENAME);

    task.onLog(`Using ${runtime.effectiveEncoder} encoder profile for progressive playback.`);
    this.log(
      'info',
      `Queued progressive MP4 encode with ${runtime.effectiveEncoder}.`,
      task.jobId,
    );

    const h264Command = ffmpeg(task.sourcePath)
      .inputOptions(runtime.inputOptions)
      .videoFilters(progressiveScaleFilter)
      .output(primaryPlaybackPath)
      .outputOptions(
        '-map',
        '0:v:0',
        ...(probe.hasAudio ? ['-map', '0:a:0?'] : []),
        ...getProgressiveMp4OutputOptions(runtime),
        ...(probe.hasAudio
          ? ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k']
          : []),
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
      );

    await this.runFfmpegCommand({
      command: h264Command,
      durationSeconds: probe.durationSeconds,
      onLog: task.onLog,
      onProgress: (progress) => task.onProgress(clamp(progress * 0.8)),
    });

    const packagedSources: StoredVideoSource[] = [
      {
        codec: 'h264',
        mimeType: 'video/mp4',
        url: '',
        objectKey: PROGRESSIVE_H264_FILENAME,
      },
    ];

    const av1Source = await this.encodeAv1Source(
      task,
      probe,
      av1PlaybackPath,
      PROGRESSIVE_AV1_FILENAME,
    );
    if (av1Source) {
      packagedSources.push(av1Source);
    }

    const posterPath = task.settings.extractPosterFrame
      ? await this.extractPoster(task, probe.durationSeconds)
      : null;

    task.onProgress(100);
    return {
      deliveryType: 'progressive',
      durationSeconds: probe.durationSeconds,
      frameRate: probe.frameRate,
      width: probe.width,
      height: probe.height,
      posterPath,
      masterPlaylistPath: null,
      manifestRelativePath: null,
      playbackRelativePath: PROGRESSIVE_H264_FILENAME,
      sources: sortStoredVideoSources(
        packagedSources.map((source) => ({
          codec: source.codec,
          mimeType: source.mimeType,
          relativePath: source.objectKey,
        })),
      ),
      effectiveEncoder: runtime.effectiveEncoder,
    };
  }

  private async encodeAv1Source(
    task: TranscodeTask,
    probe: SourceProbe,
    outputPath: string,
    relativePath: string,
  ): Promise<StoredVideoSource | null> {
    for (const attempt of getAv1Attempts()) {
      await unlink(outputPath).catch(() => undefined);
      task.onLog(`Generating AV1 progressive rendition with ${attempt.label}.`);

      const command = ffmpeg(task.sourcePath)
        .videoFilters(buildProgressiveScaleFilter())
        .output(outputPath)
        .outputOptions(
          '-map',
          '0:v:0',
          ...(probe.hasAudio ? ['-map', '0:a:0?'] : []),
          ...attempt.outputOptions,
          ...(probe.hasAudio ? ['-c:a', 'libopus', '-b:a', '96k'] : []),
        );

      try {
        await this.runFfmpegCommand({
          command,
          durationSeconds: probe.durationSeconds,
          onLog: task.onLog,
          onProgress: (progress) => task.onProgress(clamp(80 + progress * 0.18)),
        });

        return {
          codec: 'av1',
          mimeType: 'video/webm',
          url: '',
          objectKey: relativePath,
        };
      } catch (error) {
        task.onLog(
          `AV1 encode via ${attempt.label} failed (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    task.onLog('AV1 rendition skipped after encoder attempts failed. H.264 fallback will still be published.');
    return null;
  }

  private async extractPoster(task: TranscodeTask, durationSeconds: number) {
    const posterPath = path.join(task.outputDirectory, 'poster.jpg');
    const posterTimestampSeconds =
      durationSeconds > 10 ? 10 : Math.max(0.25, Number((durationSeconds / 2).toFixed(2)));

    const command = ffmpeg(task.sourcePath)
      .seekInput(posterTimestampSeconds)
      .frames(1)
      .output(posterPath)
      .outputOptions('-q:v', '2');

    try {
      await this.runFfmpegCommand({
        command,
        durationSeconds: 0,
        onLog: task.onLog,
      });
      return posterPath;
    } catch (error) {
      task.onLog(
        `Poster extraction skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async ensureMasterPlaylistPath(
    masterPlaylistPath: string,
    legacyMasterPlaylistPath: string,
    commandStartedAt: number,
  ) {
    try {
      await stat(masterPlaylistPath);
      return;
    } catch {
      // Fall through to the legacy cwd-relative path used by FFmpeg's HLS muxer.
    }

    const legacyStats = await stat(legacyMasterPlaylistPath).catch(() => null);
    if (!legacyStats || legacyStats.mtimeMs + 1000 < commandStartedAt) {
      throw new Error('FFmpeg finished without creating a master playlist in the output folder.');
    }

    await copyFile(legacyMasterPlaylistPath, masterPlaylistPath);
    await unlink(legacyMasterPlaylistPath).catch(() => undefined);
  }

  private async runFfmpegCommand({
    command,
    durationSeconds,
    onLog,
    onProgress,
    onStart,
  }: {
    command: ReturnType<typeof ffmpeg>;
    durationSeconds: number;
    onLog: (message: string) => void;
    onProgress?: (progress: number) => void;
    onStart?: (commandLine: string) => void;
  }) {
    await new Promise<void>((resolve, reject) => {
      command.on('start', (commandLine: string) => {
        onStart?.(commandLine);
        onLog(commandLine);
      });

      command.on('progress', (progress: { timemark?: string; percent?: number }) => {
        if (!onProgress) {
          return;
        }

        const seconds = parseTimemarkToSeconds(progress.timemark);
        const percent =
          durationSeconds > 0
            ? clamp((seconds / durationSeconds) * 100)
            : clamp(progress.percent || 0);
        onProgress(percent);
      });

      command.on('stderr', (line: string) => {
        onLog(line);
      });

      command.on('error', (error: Error, stdout: string, stderr: string) => {
        const failureDetails = [error.message, stdout, stderr].filter(Boolean).join('\n');
        reject(new Error(detectPipelineError(failureDetails)));
      });

      command.on('end', () => {
        resolve();
      });

      command.run();
    });
  }
}
