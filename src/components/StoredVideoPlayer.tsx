import { useEffect, useRef } from 'react';
import HlsJs from 'hls.js';
// eslint-disable-next-line import/no-unresolved
import Plyr from 'plyr';
import { getManifestUrl, inferStoredDeliveryType, sortStoredVideoSources } from '../shared/media';
import type { StoredVideoSnapshot } from '../shared/types';

const PLYR_CONTROLS = [
  'play-large',
  'play',
  'progress',
  'current-time',
  'mute',
  'volume',
  'captions',
  'settings',
  'pip',
  'airplay',
  'fullscreen',
];

interface StoredVideoPlayerProps {
  video: StoredVideoSnapshot;
  controlsVisibility?: 'always' | 'hover';
}

export default function StoredVideoPlayer({ controlsVisibility = 'always', video }: StoredVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const deliveryType = inferStoredDeliveryType(video);
  const manifestUrl = getManifestUrl(video);
  const progressiveSources = sortStoredVideoSources(video.sources);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return undefined;
    }

    let hls: HlsJs | null = null;

    if (deliveryType === 'hls' && manifestUrl) {
      // eslint-disable-next-line import/no-named-as-default-member
      if (HlsJs.isSupported()) {
        hls = new HlsJs({ enableWorker: true });
        hls.loadSource(manifestUrl);
        hls.attachMedia(videoElement);
      } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        videoElement.src = manifestUrl;
      }
    }

    const player = new Plyr(videoElement, {
      controls: PLYR_CONTROLS,
      fullscreen: { enabled: true, fallback: true, iosNative: true },
      keyboard: { focused: true, global: false },
      ratio: '16:9',
    });

    return () => {
      player.destroy();
      hls?.destroy();
      videoElement.removeAttribute('src');
      videoElement.load();
    };
  }, [deliveryType, manifestUrl, video._id]);

  return (
    <div
      className={`stored-video-player ${
        controlsVisibility === 'hover' ? 'stored-video-player--hover-controls' : ''
      }`}
    >
      <video
        ref={videoRef}
        aria-label={video.title}
        crossOrigin="anonymous"
        playsInline
        poster={video.posterUrl}
        preload="metadata"
      >
        {deliveryType !== 'hls' &&
          progressiveSources.map((source) => (
            <source key={source.objectKey} src={source.url} type={source.mimeType} />
          ))}
        {deliveryType !== 'hls' && video.playbackUrl && <source src={video.playbackUrl} type="video/mp4" />}
      </video>
    </div>
  );
}
