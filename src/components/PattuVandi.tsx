"use client";


import { useEffect } from "react";
import type { Track } from "@/lib/types";
import { usePlayerStore, useCurrentTrack, useDurationMs } from "@/lib/player-store";
import * as engine from "@/lib/preview-engine";
import * as spotify from "@/lib/audio-engine";
import * as media from "@/lib/media-session";
import { TopBar } from "./TopBar";
import { Hero } from "./Hero";
import { PlayerPill } from "./PlayerPill";
import { YouTubeMount } from "./YouTubeMount";

/**
 * What the optional Spotify auth routes redirect back with. Reaching any of
 * these is no longer a problem to solve — playback does not depend on Spotify —
 * so the copy stays out of the listener's way.
 */
const AUTH_ERROR_COPY: Record<string, string> = {
  premium: "That Spotify account isn't Premium. Playing from YouTube instead.",
  auth_denied: "Spotify sign-in was cancelled.",
  auth_state: "Spotify sign-in didn't complete.",
  auth_failed: "Spotify sign-in failed.",
  not_configured: "Spotify sign-in isn't set up on this site.",
};

export function PattuVandi() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = useCurrentTrack();
  const durationMs = useDurationMs();

  /**
   * Publish the track to the OS: lock screen, notification shade, media keys,
   * Bluetooth buttons, car stereo. Audio already keeps playing when the tab is
   * backgrounded — this is what makes it visible and controllable while it does.
   */
  useEffect(() => {
    media.publishMetadata(currentTrack);
  }, [currentTrack]);

  useEffect(() => {
    media.setPlaybackState(isPlaying ? "playing" : "paused");
  }, [isPlaying]);

  useEffect(() => {
    const store = usePlayerStore.getState;
    return media.registerHandlers({
      onPlay: () => {
        if (!store().isPlaying) store().toggle();
      },
      onPause: () => {
        if (store().isPlaying) store().toggle();
      },
      onNext: () => store().next(),
      onPrev: () => store().prev(),
      onSeekTo: (seconds) => store().seekTo(seconds * 1000),
      onSeekBy: (delta) => store().seekTo(store().progressMs + delta * 1000),
    });
  }, []);

  /**
   * Keep the OS scrubber roughly in step. Throttled to about once a second:
   * the engine reports four times that, and the lock screen cannot show it.
   */
  useEffect(() => {
    if (!isPlaying || durationMs <= 0) return;
    const update = () =>
      media.setPositionState(usePlayerStore.getState().progressMs, durationMs);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [isPlaying, durationMs]);

  /** Hydrate the catalogue at runtime — nothing about it is baked into the build. */
  useEffect(() => {
    const store = usePlayerStore.getState;
    let cancelled = false;

    // Surface whatever an optional OAuth round trip came back with.
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    if (authError) {
      store().setError(AUTH_ERROR_COPY[authError] ?? "Spotify sign-in didn't complete.");
    }
    if (authError || params.get("connected")) {
      // Clean the URL so a refresh does not replay the message.
      window.history.replaceState(null, "", window.location.pathname);
    }

    void (async () => {
      try {
        const res = await fetch("/api/tracks", { cache: "no-store" });
        const json = (await res.json()) as {
          tracks?: Track[];
          source?: string;
          fullTrackCount?: number;
          warning?: string | null;
        };
        if (cancelled) return;

        if (!res.ok || !json.tracks?.length) {
          store().setCatalogueError("Couldn't load the playlist. Try again shortly.");
          return;
        }

        store().setTracks(json.tracks);
        // Says how the list was resolved, and whether `npm run sync` is due.
        if (json.warning) console.warn(`catalogue: ${json.warning}`);
        else {
          console.info(
            `catalogue: ${json.source} — ${json.fullTrackCount}/${json.tracks.length} full length`,
          );
        }
      } catch {
        if (!cancelled) {
          store().setCatalogueError("Couldn't load the playlist. Try again shortly.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Wire the media element once. Progress comes from its own `timeupdate`, so
   * the bar cannot drift from the audio the way a timer would.
   *
   * Attaching here rather than in the store keeps the listeners tied to a React
   * lifecycle; the element itself is a module singleton, so Strict Mode's
   * double-mount attaches and detaches without ever creating a second stream.
   */
  useEffect(() => {
    const store = usePlayerStore.getState;

    return engine.subscribe({
      // These only take effect in preview mode; the other engines drive
      // their own state and would otherwise fight this one for the store.
      onPlay: () => {
        if (store().mode === "preview") store().setPlaying(true);
      },
      onPause: () => {
        if (store().mode === "preview") store().setPlaying(false);
      },
      onTime: (ms) => {
        // The element's own duration, so the bar states the clip's length
        // rather than the full track's.
        if (store().mode === "preview") store().setPreviewProgress(ms, engine.durationMs());
      },
      onEnded: () => {
        if (store().mode === "preview") store().handleEnded();
      },
      onWaiting: () => {
        if (store().mode === "preview") store().setBuffering(true);
      },
      onError: () => {
        if (store().mode === "preview") store().setError("This track could not be played.");
      },
    });
  }, []);

  /**
   * Full-track playback. Only attempted when a Spotify session exists — the
   * SDK's getOAuthToken would fail on its first call otherwise.
   *
   * Everything stays on previews until the SDK reports a registered device, so
   * a failure here degrades rather than breaking playback entirely.
   */
  useEffect(() => {
    const store = usePlayerStore.getState;
    let cancelled = false;

    void (async () => {
      const connected = await spotify.isAuthenticated();
      if (cancelled) return;
      store().setConnected(connected);
      if (!connected) return;

      void spotify
        .init({
          onReady: () => !cancelled && store().setSpotifyReady(true),
          onNotReady: () => !cancelled && store().setSpotifyReady(false),
          onState: (state) => !cancelled && store().syncFromSpotify(state),
          onAutoplayFailed: () => {
            // Expected on mobile until a gesture; the play button is the gesture.
          },
          onError: (kind, message) => {
            if (cancelled) return;
            console.warn(`spotify: ${kind}_error`, message);
            // Premium is the usual cause; fall back rather than dead-end.
            store().setSpotifyReady(false);
            if (kind === "account") {
              store().setError("Spotify Premium is required for full tracks — playing previews.");
            } else if (kind === "authentication") {
              store().setConnected(false);
            }
          },
        })
        .catch(() => {
          if (!cancelled) store().setSpotifyReady(false);
        });
    })();

    return () => {
      cancelled = true;
      // The engine is a module singleton; disconnecting here would tear down
      // the player that Strict Mode's second mount is about to reuse.
    };
  }, []);

  // The SDK reports position only on change, so poll while it is playing.
  useEffect(() => {
    if (!isPlaying) return;
    const store = usePlayerStore.getState;
    if (store().mode !== "spotify") return;

    const timer = window.setInterval(() => {
      void spotify.getState().then((state) => {
        if (state) usePlayerStore.getState().syncFromSpotify(state);
      });
    }, 500);

    return () => window.clearInterval(timer);
  }, [isPlaying]);

  /**
   * Save the position on the way out.
   *
   * The store throttles writes to once every few seconds, so closing the tab
   * mid-song would otherwise lose up to that much. `visibilitychange` is the
   * event that actually fires when a tab is closed or backgrounded on mobile —
   * `beforeunload` is unreliable there and blocks the back/forward cache.
   */
  useEffect(() => {
    // Unconditional: firing on the way back to visible writes the same value,
    // and gating it risks missing the one case that matters.
    const persist = () => usePlayerStore.getState().savePositionNow();
    document.addEventListener("visibilitychange", persist);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", persist);
      window.removeEventListener("pagehide", persist);
    };
  }, []);

  // Keyboard shortcuts (§33): space/k play-pause, arrows seek, j/l prev/next.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }

      const store = usePlayerStore.getState();
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          // Space would otherwise scroll and re-trigger the focused button.
          e.preventDefault();
          store.toggle();
          break;
        case "ArrowRight":
          e.preventDefault();
          store.seekTo(store.progressMs + 5000);
          break;
        case "ArrowLeft":
          e.preventDefault();
          store.seekTo(store.progressMs - 5000);
          break;
        case "j":
        case "J":
          store.prev();
          break;
        case "l":
        case "L":
          store.next();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {/*
        Full-bleed backdrop, and a sibling of .shell rather than a child.

        It must NOT use a negative z-index: `body` carries an opaque
        background-color, and a fixed element at -z-10 paints behind that
        background rather than behind the content — which renders the whole
        artwork invisible and leaves a black screen. z-0 here, content above.
      */}
      {/*
        `is-playing` lives on a wrapper around BOTH the backdrop and the shell.
        It was on .shell, which meant `.is-playing .backdrop` could never match
        once the backdrop became a sibling — the drift silently stopped working.
      */}
      <div className={isPlaying ? "is-playing" : undefined}>
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
          {/* Animated backdrop video — replaces the static PNG.
              Autoplays muted and loops to create a living background. */}
          <video
            autoPlay
            loop
            muted
            playsInline
            className="backdrop object-cover absolute inset-0 w-full h-full blur-[2px]"
          >
            <source src="/pattu-vandi-background-video.mp4" type="video/mp4" />
          </video>
        </div>

        {/* Grain sits above the artwork but below the UI. */}
        <div className="grain" aria-hidden />

        {/* The iframe that produces the sound. Rendered but transparent — see
            YouTubeMount for why it cannot simply be display:none. */}
        <YouTubeMount />

        <div className="shell relative z-10">
          <TopBar />
          <Hero />
          <PlayerPill />
        </div>
      </div>
    </>
  );
}
