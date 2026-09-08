import { createPlayer } from '@videojs/react';
// eslint-disable-next-line import/no-unresolved
import '@videojs/react/video/skin.css';
// eslint-disable-next-line import/no-unresolved
import { Video, VideoSkin, videoFeatures } from '@videojs/react/video';
// eslint-disable-next-line import/no-unresolved
import { HlsVideo } from '@videojs/react/media/hls-video';
import { getManifestUrl, inferStoredDeliveryType, sortStoredVideoSources } from '../shared/media';
import type { StoredVideoSnapshot } from '../shared/types';

const Player = createPlayer({ features: videoFeatures });

interface StoredVideoPlayerProps {
  video: StoredVideoSnapshot;
  controlsVisibility?: 'always' | 'hover';
}

export default function StoredVideoPlayer({ controlsVisibility = 'always', video }: StoredVideoPlayerProps) {
  const deliveryType = inferStoredDeliveryType(video);
  const manifestUrl = getManifestUrl(video);
  const progressiveSources = sortStoredVideoSources(video.sources);

  const media =
    deliveryType === 'hls' && manifestUrl ? (
      <HlsVideo
        aria-label={video.title}
        crossOrigin="anonymous"
        playsInline
        preferPlayback="mse"
        preload="metadata"
        src={manifestUrl}
        type="application/vnd.apple.mpegurl"
      />
    ) : (
      <Video
        aria-label={video.title}
        crossOrigin="anonymous"
        playsInline
        poster={video.posterUrl}
        preload="metadata"
      >
        {progressiveSources.map((source) => (
          <source key={source.objectKey} src={source.url} type={source.mimeType} />
        ))}
        {video.playbackUrl && <source src={video.playbackUrl} type="video/mp4" />}
      </Video>
    );

  return (
    <div
      className={`stored-video-player ${
        controlsVisibility === 'hover' ? 'stored-video-player--hover-controls' : ''
      }`}
    >
      <Player.Provider key={video._id}>
        <VideoSkin className="stored-video-player__skin" poster={video.posterUrl}>
          {media}
        </VideoSkin>
      </Player.Provider>
    </div>
  );
}
