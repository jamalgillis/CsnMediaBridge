import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
// eslint-disable-next-line import/no-unresolved
import Plyr from 'plyr';

const PLYR_CONTROLS = [
  'play-large',
  'play',
  'progress',
  'current-time',
  'duration',
  'mute',
  'volume',
  'fullscreen',
];

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
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return undefined;
    }

    const player = new Plyr(videoElement, {
      controls: PLYR_CONTROLS,
      fullscreen: { enabled: true, fallback: true, iosNative: true },
      keyboard: { focused: true, global: false },
      ratio: '16:9',
    });

    return () => {
      player.destroy();
    };
  }, [sourceUrl]);

  return (
    <div className="trim-video-player">
      <video
        ref={videoRef}
        aria-label={title}
        onLoadedMetadata={onLoadedMetadata}
        onPause={onPause}
        onPlay={onPlay}
        onTimeUpdate={onTimeUpdate}
        playsInline
        preload="auto"
        src={sourceUrl}
      />
    </div>
  );
});

export default TrimVideoPlayer;
