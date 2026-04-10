import { forwardRef } from 'react';
import { createPlayer } from '@videojs/react';
// eslint-disable-next-line import/no-unresolved
import '@videojs/react/video/skin.css';
// eslint-disable-next-line import/no-unresolved
import { Video, VideoSkin, videoFeatures } from '@videojs/react/video';

const Player = createPlayer({ features: videoFeatures });

interface TrimVideoPlayerProps {
  sourceUrl: string;
  title: string;
  onLoadedMetadata: () => void;
  onPause: () => void;
  onPlay: () => void;
  onTimeUpdate: () => void;
}

const TrimVideoPlayer = forwardRef<HTMLVideoElement, TrimVideoPlayerProps>(function TrimVideoPlayer(
  { sourceUrl, title, onLoadedMetadata, onPause, onPlay, onTimeUpdate },
  ref,
) {
  return (
    <div className="trim-video-player">
      <Player.Provider key={sourceUrl}>
        <VideoSkin className="trim-video-player__skin">
          <Video
            ref={ref}
            aria-label={title}
            onLoadedMetadata={onLoadedMetadata}
            onPause={onPause}
            onPlay={onPlay}
            onTimeUpdate={onTimeUpdate}
            playsInline
            preload="auto"
            src={sourceUrl}
          />
        </VideoSkin>
      </Player.Provider>
    </div>
  );
});

export default TrimVideoPlayer;
