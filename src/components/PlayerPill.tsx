"use client";

import Image from "next/image";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import {
  usePlayerStore,
  useCurrentTrack,
  useDurationMs,
  useIsFullTrack,
} from "@/lib/player-store";
import { formatMs, spokenMs } from "@/lib/format-time";

function Scrubber() {
  const progressMs = usePlayerStore((s) => s.progressMs);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const durationMs = useDurationMs();

  const trackRef = useRef<HTMLDivElement>(null);
  // Ref, not state: pointerup can arrive before a state update from pointerdown
  // has committed, and a stale closure would drop the seek.
  const draggingRef = useRef(false);
  const [scrub, setScrub] = useState<number | null>(null);

  const shown = scrub ?? progressMs;
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, shown / durationMs)) : 0;

  function msFromEvent(clientX: number): number {
    const el = trackRef.current;
    if (!el || durationMs <= 0) return 0;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * durationMs;
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuenow={Math.round(shown / 1000)}
      aria-valuetext={`${spokenMs(shown)} of ${spokenMs(durationMs)}`}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (durationMs <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingRef.current = true;
        setScrub(msFromEvent(e.clientX));
      }}
      onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (!draggingRef.current) return;
        setScrub(msFromEvent(e.clientX));
      }}
      onPointerUp={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const target = msFromEvent(e.clientX);
        setScrub(null);
        seekTo(target);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setScrub(null);
      }}
      onKeyDown={(e) => {
        if (durationMs <= 0) return;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          seekTo(progressMs + 5000);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          seekTo(progressMs - 5000);
        }
      }}
      // touch-action:none or the browser claims the gesture for scrolling.
      // The negative margin keeps a ~22px hit area without thickening the line.
      className="group/scrub -my-2.5 w-full cursor-pointer touch-none py-2.5 select-none"
    >
      <div className="relative h-[3px] w-full rounded-full bg-white/25">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-ink)]"
          style={{ width: `${ratio * 100}%` }}
        />
        {/* pointer-coarse keeps the thumb permanently visible on touch: there is
            no hover on a phone, so it would otherwise stay invisible for the
            whole drag and leave the gesture with no handle to follow. */}
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-ink)] opacity-0 transition-opacity duration-150 group-hover/scrub:opacity-100 group-focus-visible/scrub:opacity-100 pointer-coarse:opacity-100"
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

// 44px minimum touch target, built from padding rather than icon size.
const GHOST_BUTTON =
  "flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-ink-soft)] transition-colors duration-200 hover:text-[var(--color-ink)] active:text-[var(--color-ink)]";

function PillSkeleton({ message }: { message: string }) {
  return (
    <div className="relative z-20 flex justify-center px-3 pb-4 sm:px-4 sm:pb-5">
      <div className="player-pill w-full max-w-2xl rounded-3xl px-3.5 py-3 backdrop-blur-xl backdrop-saturate-150 sm:rounded-full sm:px-5 sm:py-3.5">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 rounded-full bg-white/10 sm:h-14 sm:w-14" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.9rem] text-[var(--color-ink-soft)]">{message}</p>
            <div className="mt-3 h-[3px] w-full rounded-full bg-white/15" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlayerPill() {
  const track = useCurrentTrack();
  const durationMs = useDurationMs();
  const progressMs = usePlayerStore((s) => s.progressMs);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoadingCatalogue = usePlayerStore((s) => s.isLoadingCatalogue);
  const catalogueError = usePlayerStore((s) => s.catalogueError);
  const trackError = usePlayerStore((s) => s.error);
  const isFullTrack = useIsFullTrack();
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);

  if (catalogueError) return <PillSkeleton message={catalogueError} />;
  if (isLoadingCatalogue) return <PillSkeleton message="Loading tracks…" />;
  if (!track) return null;

  return (
    <div className="relative z-20 flex justify-center px-3 pb-4 sm:px-4 sm:pb-5">
      {/*
        The grid reflows rather than shrinking. On a single row the metadata
        column is squeezed to ~16px at 320px wide, which cannot hold a title,
        an artist and a scrubber — so below 640px it becomes three rows.
        backdrop-blur comes from Tailwind, which emits both the prefixed and
        unprefixed properties; declaring them by hand cost Firefox the blur.
      */}
      <div className="player-pill player-grid w-full max-w-2xl rounded-3xl px-3.5 py-3 backdrop-blur-xl backdrop-saturate-150 sm:rounded-full sm:px-5 sm:py-3.5">
        {/* The artwork is the record: it turns while playing and holds its
            angle when paused, rather than resetting like a spinner. */}
        <div className="pp-art disc relative h-12 w-12 shrink-0 sm:h-14 sm:w-14">
          <div className="disc-spin relative h-full w-full overflow-hidden rounded-full bg-black/40">
            <Image
              key={track.id}
              src={track.image || "/Favicon.png"}
              alt=""
              aria-hidden
              fill
              sizes="56px"
              className="anim-fade object-cover"
            />
            <span className="disc-grooves" aria-hidden />
            <span className="disc-spindle" aria-hidden />
          </div>
          <span className="disc-sheen" aria-hidden />
        </div>

        <div className="pp-meta min-w-0">
          <p
            className="truncate text-[0.95rem] leading-tight text-[var(--color-ink)] drop-shadow-[0_1px_4px_rgba(0,0,0,0.5)] sm:text-[1.05rem]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {track.name}
          </p>
          <p className="mt-0.5 truncate text-[0.72rem] leading-tight tracking-wide text-[var(--color-ink-soft)] sm:text-[0.78rem]">
            {track.artist}
          </p>
        </div>

        <div className="pp-seek min-w-0">
          <Scrubber />
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <p className="text-[0.65rem] tracking-[0.08em] text-[var(--color-ink-faint)] tabular-nums sm:text-[0.68rem]">
              {trackError ? (
                <span className="text-[var(--color-ink)]">{trackError}</span>
              ) : (
                <>
                  {formatMs(progressMs)} <span className="opacity-50">/</span>{" "}
                  {formatMs(durationMs)}
                </>
              )}
            </p>

            {/*
              A quiet statement of what is playing, never a prompt. There is
              nothing to sign in to and nothing to upgrade, so the old "Connect
              for full tracks" link is gone — full tracks are the default. This
              only says "Preview" on the rare track with no video match.
            */}
            {!isFullTrack && (
              <span className="text-[0.6rem] tracking-[0.18em] whitespace-nowrap text-[var(--color-ink-faint)] uppercase">
                Preview
              </span>
            )}
          </div>
        </div>

        <div className="pp-controls flex shrink-0 items-center gap-1 sm:gap-2">
          <button type="button" onClick={prev} aria-label="Previous track" className={GHOST_BUTTON}>
            <SkipBack size={19} strokeWidth={2} fill="currentColor" />
          </button>

          <button
            type="button"
            onClick={toggle}
            // The label tracks the state, not the icon.
            aria-label={isPlaying ? "Pause" : "Play"}
            className="flex h-13 w-13 items-center justify-center rounded-full bg-[var(--color-ink)] text-neutral-900 shadow-lg transition-transform duration-200 hover:scale-105 active:scale-95"
            style={{ height: "3.25rem", width: "3.25rem" }}
          >
            {isPlaying ? (
              <Pause size={21} strokeWidth={2} fill="currentColor" />
            ) : (
              <Play size={21} strokeWidth={2} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>

          <button type="button" onClick={next} aria-label="Next track" className={GHOST_BUTTON}>
            <SkipForward size={19} strokeWidth={2} fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
}
