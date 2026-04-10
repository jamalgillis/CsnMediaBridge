import path from 'node:path';
import type { AppSettings, EffectiveHardwareEncoder } from '../../shared/types';

export interface EncoderRuntimeConfig {
  effectiveEncoder: EffectiveHardwareEncoder;
  inputOptions: string[];
}

export interface OutputTargets {
  jobFolderName: string;
  outputDirectory: string;
  masterPlaylistPath: string;
}

export function getSoftwareEncoderRuntime(): EncoderRuntimeConfig {
  return {
    effectiveEncoder: 'software',
    inputOptions: [],
  };
}

export function resolveEncoderRuntime(settings: AppSettings): EncoderRuntimeConfig {
  let effectiveEncoder: EffectiveHardwareEncoder = 'software';

  if (settings.hardwareEncoderOverride === 'nvenc') {
    effectiveEncoder = 'nvenc';
  } else if (settings.hardwareEncoderOverride === 'videotoolbox') {
    effectiveEncoder = 'videotoolbox';
  } else if (settings.hardwareEncoderOverride === 'software') {
    effectiveEncoder = 'software';
  } else if (process.platform === 'win32') {
    effectiveEncoder = 'nvenc';
  } else if (process.platform === 'darwin') {
    effectiveEncoder = 'videotoolbox';
  }

  if (effectiveEncoder === 'nvenc') {
    return {
      effectiveEncoder,
      inputOptions: ['-hwaccel', 'cuda'],
    };
  }

  if (effectiveEncoder === 'videotoolbox') {
    return {
      effectiveEncoder,
      inputOptions: [],
    };
  }

  return getSoftwareEncoderRuntime();
}

export function buildMasterPlaylistPath(outputDirectory: string) {
  return path.join(outputDirectory, 'master.m3u8');
}
