import { useEffect, useRef, useState } from 'react';
import HlsJs from 'hls.js';
// eslint-disable-next-line import/no-unresolved
import Plyr from 'plyr';
import { getManifestUrl, inferStoredDeliveryType, sortStoredVideoSources } from '../shared/media';
import { rememberPosition, resumePosition } from '../lib/resume';
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

/** Probing: not yet known. `null`: no storyboard for this video. */
type Storyboard = string | null | undefined;

export default function StoredVideoPlayer({ controlsVisibility = 'always', video }: StoredVideoPlayerProps) {
  /**
   * React renders this empty and never puts anything in it. The `<video>` is
   * made by hand below instead, because Plyr does not leave a media element
   * where it found it: on setup it moves the element inside its own chrome,
   * and on `destroy()` it puts back a *clone* it took at setup — a different
   * node than the one it was given.
   *
   * A `<video>` rendered by React therefore disappears out from under React
   * the first time the player is torn down, and the next update that touches
   * it dies on "The object can not be found here." That is what blanked the
   * window when switching videos: switching re-ran this effect, the clone
   * landed in the DOM, and React's next render went looking for a node that
   * was no longer there.
   *
   * Owning the element by hand ends the argument. React manages this one div
   * and never looks inside it; Plyr can wrap, move and swap whatever it likes.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const deliveryType = inferStoredDeliveryType(video);
  const manifestUrl = getManifestUrl(video);
  const progressiveSources = sortStoredVideoSources(video.sources);
  // Rebuilding on a changed source list, rather than on a changed video id,
  // also covers a video that was re-encoded in place.
  const sourceSignature = [...progressiveSources.map((source) => source.url), video.playbackUrl ?? '']
    .join('|');

  /**
   * A storyboard's address is derived from the playback package, so it exists
   * for every finished video whether or not one was ever generated — anything
   * ingested before scrub previews has none. Pointing Plyr at a missing file
   * makes it retry on every hover, so the file is checked for once and the
   * feature is only offered when it is really there.
   */
  const [storyboard, setStoryboard] = useState<Storyboard>(undefined);
  const thumbnailsUrl = video.thumbnailsUrl;

  useEffect(() => {
    if (!thumbnailsUrl) {
      setStoryboard(null);
      return undefined;
    }

    let cancelled = false;
    setStoryboard(undefined);

    void fetch(thumbnailsUrl, { method: 'HEAD' })
      .then((response) => {
        if (!cancelled) {
          setStoryboard(response.ok ? thumbnailsUrl : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStoryboard(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [thumbnailsUrl]);

  useEffect(() => {
    const stage = stageRef.current;
    // Waiting for the probe means the player is built once, rather than being
    // torn down and rebuilt the moment a storyboard turns up.
    if (!stage || storyboard === undefined) {
      return undefined;
    }

    const videoElement = document.createElement('video');
    videoElement.setAttribute('aria-label', video.title);
    videoElement.crossOrigin = 'anonymous';
    videoElement.playsInline = true;
    videoElement.preload = 'metadata';
    if (video.posterUrl) {
      videoElement.poster = video.posterUrl;
    }

    if (deliveryType !== 'hls') {
      const progressive = [
        ...progressiveSources.map((source) => ({ url: source.url, mimeType: source.mimeType })),
        ...(video.playbackUrl ? [{ url: video.playbackUrl, mimeType: 'video/mp4' }] : []),
      ];

      for (const source of progressive) {
        const sourceElement = document.createElement('source');
        sourceElement.src = source.url;
        sourceElement.type = source.mimeType;
        videoElement.append(sourceElement);
      }
    }

    stage.append(videoElement);
    videoRef.current = videoElement;

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

    // Plyr replaces the element with its own chrome. If that throws — a bad
    // option, a version change — native controls are the fallback, because a
    // black rectangle with nothing on it is indistinguishable from a video
    // that simply will not play.
    let player: Plyr | null = null;
    try {
      player = new Plyr(videoElement, {
        controls: PLYR_CONTROLS,
        fullscreen: { enabled: true, fallback: true, iosNative: true },
        keyboard: { focused: true, global: false },
        ratio: '16:9',
        ...(storyboard ? { previewThumbnails: { enabled: true, src: storyboard } } : {}),
      });
    } catch (error) {
      console.error('Falling back to native video controls', error);
      videoElement.controls = true;
    }

    // Pick up where this station left off. Waiting for metadata means the
    // duration is known, so a position past the end of a re-encoded video is
    // rejected rather than seeking into nothing.
    const videoId = video._id;
    let restored = false;

    function restorePosition() {
      if (restored) {
        return;
      }
      restored = true;

      const resumeAt = resumePosition(videoId, videoElement.duration);
      if (resumeAt !== null) {
        videoElement.currentTime = resumeAt;
      }
    }

    // Writing on every timeupdate would be four storage writes a second, so
    // positions are recorded about once a second and again on the way out.
    let lastSavedAt = 0;

    function savePosition() {
      rememberPosition(videoId, videoElement.currentTime, videoElement.duration);
    }

    function onTimeUpdate() {
      const now = Date.now();
      if (now - lastSavedAt < 1000) {
        return;
      }
      lastSavedAt = now;
      savePosition();
    }

    videoElement.addEventListener('loadedmetadata', restorePosition);
    videoElement.addEventListener('timeupdate', onTimeUpdate);
    videoElement.addEventListener('pause', savePosition);
    // A closed window never runs the cleanup below, so the position is written
    // on the way out too.
    window.addEventListener('beforeunload', savePosition);

    if (videoElement.readyState >= 1) {
      restorePosition();
    }

    return () => {
      savePosition();
      videoElement.removeEventListener('loadedmetadata', restorePosition);
      videoElement.removeEventListener('timeupdate', onTimeUpdate);
      videoElement.removeEventListener('pause', savePosition);
      window.removeEventListener('beforeunload', savePosition);

      // Teardown is still allowed to fail: it should not cost the operator the
      // screen, and there is nothing here worth keeping afterwards.
      try {
        player?.destroy();
      } catch (error) {
        console.error('Could not tear down the player cleanly', error);
      }

      try {
        hls?.destroy();
      } catch (error) {
        console.error('Could not tear down the stream cleanly', error);
      }

      // Stops the download of a video nobody is watching any more.
      videoElement.removeAttribute('src');
      videoElement.load();

      // Emptying the stage removes whatever is actually in it — Plyr's chrome,
      // or the clone it leaves behind — rather than a node this code assumed
      // would still be there.
      videoRef.current = null;
      stage.replaceChildren();
    };
  }, [
    deliveryType,
    manifestUrl,
    sourceSignature,
    storyboard,
    video._id,
    // A replaced cover has to reach Plyr's poster layer, which is only read at
    // setup, so a new one rebuilds the player. The position is saved on the
    // way out and restored on the way back in, so playback resumes in place.
    video.posterUrl,
  ]);

  // A renamed video should not interrupt playback, and the label is a plain
  // attribute Plyr has no opinion about, so it is updated where it stands.
  useEffect(() => {
    videoRef.current?.setAttribute('aria-label', video.title);
  }, [video.title]);

  return (
    <div
      className={`stored-video-player ${
        controlsVisibility === 'hover' ? 'stored-video-player--hover-controls' : ''
      }`}
      ref={stageRef}
    />
  );
}
