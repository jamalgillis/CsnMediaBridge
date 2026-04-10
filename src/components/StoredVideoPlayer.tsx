import { createPlayer } from '@videojs/react';
// eslint-disable-next-line import/no-unresolved
import '@videojs/react/video/skin.css';
// eslint-disable-next-line import/no-unresolved
import { VideoSkin, videoFeatures } from '@videojs/react/video';
// eslint-disable-next-line import/no-unresolved
import { HlsVideo } from '@videojs/react/media/hls-video';
import { getManifestUrl, inferStoredDeliveryType, sortStoredVideoSources } from '../shared/media';
import type { StoredVideoSnapshot } from '../shared/types';

const Player = createPlayer({ features: videoFeatures });

interface StoredVideoPlayerProps {
  video: StoredVideoSnapshot;
}

export default function StoredVideoPlayer({ video }: StoredVideoPlayerProps) {
  const deliveryType = inferStoredDeliveryType(video);
  const manifestUrl = getManifestUrl(video);
  const progressiveSources = sortStoredVideoSources(video.sources);

  if (deliveryType === 'hls' && manifestUrl) {
    return (
      <div className="stored-video-player">
        <Player.Provider key={video._id}>
          <VideoSkin className="stored-video-player__skin" poster={video.posterUrl}>
            <HlsVideo
              aria-label={video.title}
              crossOrigin="anonymous"
              playsInline
              preferPlayback="mse"
              preload="metadata"
              src={manifestUrl}
              type="application/vnd.apple.mpegurl"
            />
          </VideoSkin>
        </Player.Provider>
      </div>
    );
  }

  return (
    <div className="stored-video-player overflow-hidden rounded-widget bg-black">
      <video
        aria-label={video.title}
        className="aspect-video w-full"
        controls
        crossOrigin="anonymous"
        playsInline
        poster={video.posterUrl}
        preload="metadata"
      >
        {progressiveSources.map((source) => (
          <source key={source.objectKey} src={source.url} type={source.mimeType} />
        ))}
        {video.playbackUrl && <source src={video.playbackUrl} type="video/mp4" />}
      </video>
    </div>
  );
}
