import { forwardRef, useEffect, useRef } from 'react';
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
  /**
   * React renders this empty and the `<video>` is made by hand, because Plyr
   * moves the element it is given and, on `destroy()`, puts back a clone taken
   * at setup rather than the original node. An element React rendered would go
   * missing from React's own tree the first time the player was torn down —
   * see the same note in StoredVideoPlayer.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Handed over the moment the element exists rather than on the next render:
  // the trimmer reads it from inside `loadedmetadata`, which can arrive first
  // and would otherwise find nothing and never set the duration.
  function handOver(element: HTMLVideoElement | null) {
    if (typeof ref === 'function') {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }
  }

  // The trimmer passes fresh handlers on every render. Reading them through a
  // ref means a re-render never rebuilds the player and interrupts playback.
  const handlers = useRef({ onLoadedMetadata, onPause, onPlay, onTimeUpdate });
  handlers.current = { onLoadedMetadata, onPause, onPlay, onTimeUpdate };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return undefined;
    }

    const element = document.createElement('video');
    element.setAttribute('aria-label', title);
    element.playsInline = true;
    element.preload = 'auto';
    element.src = sourceUrl;

    const notifyLoadedMetadata = () => handlers.current.onLoadedMetadata();
    const notifyPause = () => handlers.current.onPause();
    const notifyPlay = () => handlers.current.onPlay();
    const notifyTimeUpdate = () => handlers.current.onTimeUpdate();

    element.addEventListener('loadedmetadata', notifyLoadedMetadata);
    element.addEventListener('pause', notifyPause);
    element.addEventListener('play', notifyPlay);
    element.addEventListener('timeupdate', notifyTimeUpdate);

    handOver(element);
    stage.append(element);

    let player: Plyr | null = null;
    try {
      player = new Plyr(element, {
        controls: PLYR_CONTROLS,
        fullscreen: { enabled: true, fallback: true, iosNative: true },
        keyboard: { focused: true, global: false },
        ratio: '16:9',
      });
    } catch (error) {
      // Trimming needs a scrubbable picture more than it needs styled chrome.
      console.error('Falling back to native video controls', error);
      element.controls = true;
    }

    return () => {
      element.removeEventListener('loadedmetadata', notifyLoadedMetadata);
      element.removeEventListener('pause', notifyPause);
      element.removeEventListener('play', notifyPlay);
      element.removeEventListener('timeupdate', notifyTimeUpdate);

      try {
        player?.destroy();
      } catch (error) {
        console.error('Could not tear down the player cleanly', error);
      }

      element.removeAttribute('src');
      element.load();

      handOver(null);
      // Empties whatever is actually in the stage, Plyr's chrome and clone
      // included, instead of a node this code assumed would still be there.
      stage.replaceChildren();
    };
  }, [sourceUrl, title]);

  return <div className="trim-video-player" ref={stageRef} />;
});

export default TrimVideoPlayer;
