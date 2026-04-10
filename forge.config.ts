import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { NotaryToolCredentials } from '@electron/notarize/lib/types';
import type { OsxSignOptions } from '@electron/packager';

const APP_BUNDLE_ID = 'com.gfamagency.csnmediabridge';

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const appUpdateBaseUrl = readEnv('APP_UPDATE_BASE_URL')?.replace(/\/+$/u, '');
const appUpdateReleaseNotes = readEnv('APP_UPDATE_RELEASE_NOTES');
const appleSignIdentity = readEnv('APPLE_SIGN_IDENTITY');
const appleSignEnabled = readEnv('APPLE_SIGN_ENABLED') === 'true';
const appleKeychainProfile = readEnv('APPLE_KEYCHAIN_PROFILE');
const appleKeychain = readEnv('APPLE_KEYCHAIN');
const appleId = readEnv('APPLE_ID');
const appleIdPassword =
  readEnv('APPLE_APP_SPECIFIC_PASSWORD') ?? readEnv('APPLE_ID_PASSWORD');
const appleTeamId = readEnv('APPLE_TEAM_ID');
const appleApiKey = readEnv('APPLE_API_KEY');
const appleApiKeyId = readEnv('APPLE_API_KEY_ID');
const appleApiIssuer = readEnv('APPLE_API_ISSUER');

function buildMacSignConfig(): true | OsxSignOptions | undefined {
  if (
    !appleSignEnabled &&
    !appleSignIdentity &&
    !appleKeychainProfile &&
    !(appleId && appleIdPassword && appleTeamId) &&
    !(appleApiKey && appleApiKeyId && appleApiIssuer)
  ) {
    return undefined;
  }

  return {
    identity: appleSignIdentity,
    hardenedRuntime: true,
  };
}

function buildMacNotarizeConfig(): NotaryToolCredentials | undefined {
  if (appleKeychainProfile) {
    return {
      keychainProfile: appleKeychainProfile,
      keychain: appleKeychain,
    };
  }

  if (appleId && appleIdPassword && appleTeamId) {
    return {
      appleId,
      appleIdPassword,
      teamId: appleTeamId,
    };
  }

  if (appleApiKey && appleApiKeyId && appleApiIssuer) {
    return {
      appleApiKey,
      appleApiKeyId,
      appleApiIssuer,
    };
  }

  return undefined;
}

const osxSign = buildMacSignConfig();
const osxNotarize = osxSign ? buildMacNotarizeConfig() : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: APP_BUNDLE_ID,
    osxSign,
    osxNotarize,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'csnmediabridge',
        remoteReleases: appUpdateBaseUrl
          ? `${appUpdateBaseUrl}/win32/${process.arch}`
          : undefined,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: appUpdateBaseUrl
        ? {
            macUpdateManifestBaseUrl: `${appUpdateBaseUrl}/darwin/${process.arch}`,
            macUpdateReleaseNotes: appUpdateReleaseNotes,
          }
        : {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
