import type {
  ContentType,
  DeliveryType,
  RequestedDeliveryType,
  StoredVideoSource,
  VideoSourceCodec,
} from './types';

export const AUTO_PROGRESSIVE_MAX_DURATION_SECONDS = 60;

const SOURCE_PRIORITY: Record<VideoSourceCodec, number> = {
  av1: 0,
  hevc: 1,
  h264: 2,
};

export function isHlsUrl(value: string | null | undefined) {
  return /\.m3u8($|\?)/i.test(value ?? '');
}

export function sortStoredVideoSources<T extends Pick<StoredVideoSource, 'codec'>>(
  sources: T[] | null | undefined,
) {
  return [...(sources ?? [])].sort(
    (left, right) => SOURCE_PRIORITY[left.codec] - SOURCE_PRIORITY[right.codec],
  );
}

export function resolveDeliveryType(params: {
  requestedDelivery?: RequestedDeliveryType | null;
  durationSeconds?: number | null;
  autoProgressiveMaxDurationSeconds?: number | null;
}) {
  const requestedDelivery = params.requestedDelivery ?? 'auto';

  if (requestedDelivery === 'progressive' || requestedDelivery === 'hls') {
    return requestedDelivery;
  }

  const durationSeconds = params.durationSeconds ?? 0;
  const thresholdSeconds =
    params.autoProgressiveMaxDurationSeconds ?? AUTO_PROGRESSIVE_MAX_DURATION_SECONDS;

  return durationSeconds <= thresholdSeconds ? 'progressive' : 'hls';
}

export function inferStoredDeliveryType(asset: {
  deliveryType?: DeliveryType | null;
  manifestUrl?: string | null;
  masterPlaylistUrl?: string | null;
  playbackUrl?: string | null;
  sources?: StoredVideoSource[] | null;
}): DeliveryType {
  if (asset.deliveryType) {
    return asset.deliveryType;
  }

  if (asset.sources && asset.sources.length > 0) {
    return 'progressive';
  }

  if (
    isHlsUrl(asset.manifestUrl) ||
    isHlsUrl(asset.masterPlaylistUrl) ||
    isHlsUrl(asset.playbackUrl)
  ) {
    return 'hls';
  }

  return 'progressive';
}

export function inferStoredContentType(asset: {
  contentType?: ContentType | null;
  deliveryType?: DeliveryType | null;
  manifestUrl?: string | null;
  masterPlaylistUrl?: string | null;
  playbackUrl?: string | null;
  sources?: StoredVideoSource[] | null;
}): ContentType {
  if (asset.contentType) {
    return asset.contentType;
  }

  return inferStoredDeliveryType(asset) === 'progressive' ? 'clip' : 'vod';
}

export function getManifestUrl(asset: {
  manifestUrl?: string | null;
  masterPlaylistUrl?: string | null;
  playbackUrl?: string | null;
}) {
  if (asset.manifestUrl) {
    return asset.manifestUrl;
  }

  if (asset.masterPlaylistUrl) {
    return asset.masterPlaylistUrl;
  }

  return isHlsUrl(asset.playbackUrl) ? asset.playbackUrl ?? null : null;
}

export function getPrimaryPlaybackUrl(asset: {
  deliveryType?: DeliveryType | null;
  manifestUrl?: string | null;
  masterPlaylistUrl?: string | null;
  playbackUrl?: string | null;
  sources?: StoredVideoSource[] | null;
}) {
  const deliveryType = inferStoredDeliveryType(asset);
  if (deliveryType === 'hls') {
    return getManifestUrl(asset) ?? asset.playbackUrl ?? '';
  }

  const sortedSources = sortStoredVideoSources(asset.sources);
  const preferredSource =
    sortedSources.find((source) => source.codec === 'av1') ??
    sortedSources.find((source) => source.codec === 'h264') ??
    sortedSources[0];

  return preferredSource?.url ?? asset.playbackUrl ?? '';
}
