/**
 * Hands the current track to the operating system.
 *
 * This is what turns a backgrounded tab into something usable: the track title,
 * artist and artwork appear on the lock screen, in the notification shade, and on
 * the media widget — and the hardware play/pause/next keys, Bluetooth headset
 * buttons and car stereo controls all reach the player. Audio already survives
 * being backgrounded; without this you just cannot see or control it.
 *
 * Every call is guarded. Support varies, `setActionHandler` throws on actions a
 * browser does not implement, and `setPositionState` throws outright on numbers
 * it dislikes — a rejected media control must never take playback down with it.
 */
import type { Track } from "./types";

type Handlers = {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  /** Absolute position, in seconds — what "seekto" reports. */
  onSeekTo: (seconds: number) => void;
  /**
   * RELATIVE offset, in seconds; negative goes back. Kept separate from
   * onSeekTo on purpose: "seekbackward" carries an offset, not a destination,
   * and treating the two alike would seek to -10s instead of back 10s.
   */
  onSeekBy: (deltaSeconds: number) => void;
};

function session(): MediaSession | null {
  if (typeof navigator === "undefined") return null;
  return "mediaSession" in navigator ? navigator.mediaSession : null;
}

export function isSupported(): boolean {
  return session() !== null;
}

/**
 * Artwork in several sizes.
 *
 * Spotify serves the same image under a size token in the path, so the smaller
 * variants come free — a lock screen asking for 96px should not be handed a
 * 640px jpeg. The list is a hint; the OS picks what it wants.
 */
function artworkFor(track: Track): MediaImage[] {
  if (!track.image) {
    return [{ src: "/Favicon.png", sizes: "512x512", type: "image/png" }];
  }
  const sizes: [string, string][] = [
    ["ab67616d00004851", "64x64"],
    ["ab67616d00001e02", "300x300"],
    ["ab67616d0000b273", "640x640"],
  ];

  const known = sizes.filter(([token]) => track.image.includes(token));
  if (known.length === 0) {
    return [{ src: track.image, sizes: "640x640", type: "image/jpeg" }];
  }

  return sizes.map(([token, size]) => ({
    src: track.image.replace(/ab67616d[0-9a-f]{8}/, token),
    sizes: size,
    type: "image/jpeg",
  }));
}

export function publishMetadata(track: Track | null): void {
  const ms = session();
  if (!ms) return;
  try {
    if (!track) {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artist,
      album: track.album || "Pattu Vandi",
      artwork: artworkFor(track),
    });
  } catch {
    /* MediaMetadata unavailable */
  }
}

export function setPlaybackState(state: MediaSessionPlaybackState): void {
  const ms = session();
  if (!ms) return;
  try {
    ms.playbackState = state;
  } catch {
    /* ignore */
  }
}

/**
 * Feeds the OS scrubber. Rejects anything it would throw on rather than
 * discovering that at runtime: duration must be finite and positive, and the
 * position can never exceed it — a single bad frame throws a TypeError.
 */
export function setPositionState(positionMs: number, durationMs: number): void {
  const ms = session();
  if (!ms || typeof ms.setPositionState !== "function") return;

  const duration = durationMs / 1000;
  const position = positionMs / 1000;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!Number.isFinite(position) || position < 0) return;

  try {
    ms.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: 1,
    });
  } catch {
    /* the OS will fall back to no scrubber */
  }
}

/** Attach once. Returns a function that removes every handler again. */
export function registerHandlers(handlers: Handlers): () => void {
  const ms = session();
  if (!ms) return () => { };

  const bindings: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => handlers.onPlay()],
    ["pause", () => handlers.onPause()],
    // Some platforms send "stop" for the dismiss button on a notification.
    ["stop", () => handlers.onPause()],
    ["nexttrack", () => handlers.onNext()],
    ["previoustrack", () => handlers.onPrev()],
    ["seekto", (details) => {
      if (typeof details.seekTime === "number") handlers.onSeekTo(details.seekTime);
    }],
    ["seekbackward", (details) => handlers.onSeekBy(-(details.seekOffset ?? 10))],
    ["seekforward", (details) => handlers.onSeekBy(details.seekOffset ?? 10)],
  ];

  const attached: MediaSessionAction[] = [];
  for (const [action, handler] of bindings) {
    try {
      ms.setActionHandler(action, handler);
      attached.push(action);
    } catch {
      // Not supported here. Skipping one action must not lose the others, which
      // is why these are set individually rather than in a single try.
    }
  }

  return () => {
    for (const action of attached) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* ignore */
      }
    }
  };
}
