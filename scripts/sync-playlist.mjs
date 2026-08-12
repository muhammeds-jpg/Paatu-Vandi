#!/usr/bin/env node
/**
 * Bakes the playlist into `src/config/catalogue.generated.ts`.
 *
 *     npm run sync
 *     npm run sync -- https://open.spotify.com/playlist/<id>
 *
 * NO CREDENTIALS. No Spotify client id or secret, no Google API key, no OAuth,
 * no Premium. Every source used here is a public endpoint:
 *
 *   1. `open.spotify.com/embed/playlist/<id>` — the playlist, in order. Its
 *      `__NEXT_DATA__` blob carries each track's title, artists, real duration
 *      AND an `audioPreview.url` mp3. The *official* Web API refuses all of
 *      this without a user token, and omits `preview_url` entirely.
 *   2. `open.spotify.com/embed/track/<id>` — that track's album art.
 *   3. `youtube.com/results` — the matching video, for FULL-LENGTH playback.
 *
 * Run it whenever the playlist changes. The output is committed, so the
 * deployed site does no third-party call to boot: it serves a static list.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getUserToken, readPlaylistWithToken } from "./lib/spotify-auth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "config", "catalogue.generated.ts");

/* Chrome's UA. Both sites serve a stripped-down page to unknown agents. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const HEADERS = { "user-agent": UA, "accept-language": "en-US,en;q=0.9" };

/* ── plumbing ────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A shared brake, respected by every worker.
 *
 * YouTube does not answer a flood with an error — it answers with a 200 and an
 * empty result set. So throttling looks exactly like "that song is not on
 * YouTube", and a 100-track sync quietly produced 31 tracks of 30-second
 * previews for songs that are all plainly there. When any request smells
 * throttled, everyone slows down for a moment rather than racing on and baking
 * the damage into the catalogue.
 */
let cooldownUntil = 0;
let throttleEvents = 0;

async function respectCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

function backOff(ms) {
  throttleEvents++;
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

/**
 * Returns null rather than throwing when a URL is unreachable.
 *
 * One dud must not end the run. A redirect loop on a single track killed a
 * 100-track sync at number 30 and threw away everything already matched; a
 * missing page just means that track falls back to its preview.
 */
async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await respectCooldown();
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) {
        backOff(5_000 * (i + 1)); // an explicit refusal: stand well back
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) return null;
      return await res.text();
    } catch {
      // Backs off, then gives up quietly. Retrying a redirect loop or a hard
      // 404 forever would only stall the sync.
      if (i < tries - 1) await sleep(700 * (i + 1));
    }
  }
  return null;
}

/** Depth-first walk collecting every node the predicate likes. */
function deepFind(node, pred, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) deepFind(v, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  for (const v of Object.values(node)) deepFind(v, pred, out);
  return out;
}

function nextData(html) {
  const m = html?.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function ytInitialData(html) {
  const m =
    html?.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s) ??
    html?.match(/ytInitialData\s*=\s*(\{.+?\});\s*(?:var|window)/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Rounds to whole seconds FIRST, or 2:59.6 formats as "2:60". */
const mmss = (ms) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/* ── 1. the playlist ─────────────────────────────────────────────────────── */

function parsePlaylistId(input) {
  const s = String(input).trim();
  return (
    s.match(/playlist[/:]([A-Za-z0-9]+)/)?.[1] ??
    s.match(/^([A-Za-z0-9]{22})$/)?.[1] ??
    s
  );
}

async function readPlaylist(id) {
  const html = await getText(`https://open.spotify.com/embed/playlist/${id}`);
  // This one IS fatal — without the playlist there is nothing to sync.
  if (html === null) {
    throw new Error(
      `Could not reach Spotify for playlist ${id}. Check the id and your connection.`,
    );
  }
  const data = nextData(html);
  if (!data) throw new Error("Spotify's embed page did not include its data blob.");

  const entity = deepFind(data, (n) => Array.isArray(n.trackList))[0];
  if (!entity) throw new Error("No track list in the embed data — is the playlist PUBLIC?");

  const tracks = entity.trackList
    .filter((t) => t?.uri?.startsWith("spotify:track:"))
    .map((t) => ({
      spotifyId: t.uri.replace("spotify:track:", ""),
      title: String(t.title ?? "").trim(),
      artist: String(t.subtitle ?? "").trim(),
      durationMs: Number(t.duration ?? 0),
      previewUrl: t.audioPreview?.url ?? "",
    }));

  return {
    name: String(entity.name ?? entity.title ?? "").trim(),
    tracks,
    // The embed hard-stops at 100, ignores offset/limit entirely, and carries
    // no total — so exactly 100 is indistinguishable from "a 250-track playlist
    // truncated". Flagged here so the caller can say so out loud rather than
    // quietly shipping the first 100.
    maybeTruncated: tracks.length >= EMBED_TRACK_CAP,
    source: "embed",
  };
}

/** What the public embed will never exceed, no matter what you ask it for. */
const EMBED_TRACK_CAP = 100;

/**
 * Per-track album art. The playlist blob only carries the playlist's own cover,
 * which is wrong the moment the playlist spans more than one album.
 *
 * The art lives under `visualIdentity.image` on the track embed — NOT under
 * `coverArt`, which is the playlist/album shape. Sizes come back unordered
 * (300, 64, 640), so pick by width rather than trusting position.
 */
async function albumArt(spotifyId) {
  try {
    const data = nextData(await getText(`https://open.spotify.com/embed/track/${spotifyId}`));
    if (!data) return { image: "", album: "" };

    const images = deepFind(
      data,
      (n) => Array.isArray(n.image) && n.image.some((i) => typeof i?.url === "string"),
    )[0]?.image;

    // Fall back to the album/playlist `coverArt.sources` shape if it ever appears.
    const sources =
      images ??
      deepFind(data, (n) => n.coverArt && Array.isArray(n.coverArt.sources))[0]?.coverArt
        ?.sources ??
      [];

    const best = sources.reduce(
      (a, b) => ((b.maxWidth ?? b.width ?? 0) > (a.maxWidth ?? a.width ?? 0) ? b : a),
      sources[0] ?? {},
    );

    const entity = deepFind(data, (n) => n.type === "track" && typeof n.name === "string")[0];
    return { image: best?.url ?? "", album: String(entity?.album?.name ?? "").trim() };
  } catch {
    return { image: "", album: "" };
  }
}

/* ── 2. the YouTube match, for full-length audio ─────────────────────────── */

/** "5:04" / "1:02:11" -> ms */
function parseLength(text) {
  const parts = String(text ?? "")
    .split(":")
    .map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2) return 0;
  const secs = parts.reduce((acc, p) => acc * 60 + p, 0);
  return secs * 1000;
}

const runs = (t) => t?.simpleText ?? (t?.runs ?? []).map((r) => r.text).join("") ?? "";

/**
 * `sp=EgIQAQ%3D%3D` restricts results to videos, dropping channels/playlists.
 *
 * Returns `{ results, throttled }`. The distinction is the whole point: a real
 * query for a real song coming back with NOTHING is overwhelmingly more likely
 * to be YouTube pushing back than the song being absent, and treating the two
 * the same is what silently filled a catalogue with previews.
 */
async function searchYouTube(query) {
  const html = await getText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%3D%3D`,
  );
  if (html === null) return { results: [], throttled: true };

  // A captcha or a consent wall serves 200 with no results at all.
  if (/sorry\/index|unusual traffic|not a robot/i.test(html)) {
    backOff(15_000);
    return { results: [], throttled: true };
  }

  const data = ytInitialData(html);
  if (!data) {
    backOff(6_000);
    return { results: [], throttled: true };
  }

  const results = deepFind(data, (n) => n.videoRenderer)
    .map((n) => n.videoRenderer)
    .filter((v) => v?.videoId)
    .map((v) => ({
      videoId: v.videoId,
      rawTitle: runs(v.title),
      channel: runs(v.ownerText) || runs(v.shortBylineText),
      durationMs: parseLength(runs(v.lengthText)),
    }));

  if (results.length === 0) {
    backOff(6_000);
    return { results: [], throttled: true };
  }

  return { results, throttled: false };
}

const NOISE = /\b(reaction|review|teaser|trailer|making|behind the scenes|karaoke|instrumental|8d|slowed|reverb|nightcore|cover by|mashup|dj remix|ringtone|whatsapp status|shorts?)\b/i;

/**
 * Picks the video most likely to BE the song.
 *
 * Length is the strongest signal by far: a compilation, a one-hour loop or a
 * 30-second clip all rank highly on title alone, and any of them silently
 * replaces the track with something that is not it. Everything else only
 * breaks ties.
 */
function rank(results, want) {
  const scored = results.slice(0, 12).map((r, rank) => {
    let score = 0;

    if (r.durationMs > 0 && want > 0) {
      const drift = Math.abs(r.durationMs - want) / want;
      if (drift <= 0.06) score += 60;
      else if (drift <= 0.15) score += 42;
      else if (drift <= 0.3) score += 18;
      else if (drift <= 0.6) score -= 15;
      else score -= 60; // a different recording, or a compilation
    }
    // Anything over 15 minutes against a 3-minute track is an album rip.
    if (want > 0 && r.durationMs > Math.max(want * 3, 900_000)) score -= 80;

    if (NOISE.test(r.rawTitle)) score -= 35;
    if (/\b(official|full (video|song|audio)|lyrical|audio)\b/i.test(r.rawTitle)) score += 10;
    if (/\b(topic|records|music|official)\b/i.test(r.channel)) score += 6;

    score += Math.max(0, 12 - rank * 2); // keep YouTube's own relevance in play
    return { ...r, score };
  });

  // Anything that scored negative is a different recording, a compilation or a
  // clip. A correct 30-second preview beats a full-length wrong song, so those
  // are dropped rather than shipped.
  return scored.filter((r) => r.score >= 0).sort((a, b) => b.score - a.score);
}

/** Strips the decoration that hurts a search, keeping the words that identify it. */
function queryFor(title, artist) {
  const clean = title
    .replace(/\(from\s*"([^"]*)"\)/gi, "$1") // (From "Abhilasham") -> Abhilasham
    .replace(/["'’]/g, "")
    .replace(/\s*[-–—]\s*(the\s+)?(waiting|reprise|version|male|female)\b/gi, " $2")
    .replace(/\s+/g, " ")
    .trim();
  const primary = artist.split(/,|&|feat\.|ft\./i)[0].trim();
  return `${clean} ${primary}`.trim().slice(0, 110);
}

/**
 * Confirms the video will actually play INSIDE AN EMBED.
 *
 * A video can be public, searchable and still refuse to play off youtube.com —
 * the IFrame player answers error 101/150 and the track goes silent. That is not
 * detectable from search results, only from the watch page, so it is checked
 * here rather than discovered by a listener.
 */
async function verifyEmbeddable(videoId) {
  try {
    const html = await getText(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
    if (!html) return null;
    const playable = /"playableInEmbed"\s*:\s*(true|false)/.exec(html)?.[1];
    const status = html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/)?.[1];
    const seconds = html.match(/"lengthSeconds":"(\d+)"/)?.[1];
    return {
      ok: playable === "true" && (status === undefined || status === "OK"),
      status: status ?? "?",
      // The watch page is authoritative on length; search text can be stale.
      durationMs: seconds ? Number(seconds) * 1000 : 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param patient - used by the second pass. Waits longer and tries harder for
 *   the tracks the first pass could not place, since by then the run is nearly
 *   over and being slow costs little.
 */
async function findVideo(track, patient = false) {
  const attempts = [
    queryFor(track.title, track.artist),
    `${track.title} ${track.artist.split(/,|&/)[0]} full song`.trim().slice(0, 110),
    track.title.replace(/\(from\s*"([^"]*)"\)/gi, "$1").trim().slice(0, 110),
  ];

  // Pool every candidate first, then verify best-first. Verifying inside the
  // search loop would spend a request on a weak hit before a strong one.
  const pool = new Map();
  for (const q of attempts) {
    // Retry a throttled query instead of accepting its empty answer as truth.
    const rounds = patient ? 4 : 2;
    for (let attempt = 0; attempt < rounds; attempt++) {
      const { results, throttled } = await searchYouTube(q);
      for (const hit of results) {
        if (!pool.has(hit.videoId)) pool.set(hit.videoId, hit);
      }
      if (!throttled) break;
      await sleep((patient ? 3_000 : 1_500) * (attempt + 1));
    }
    // Enough to choose from; more queries would only cost time.
    if (pool.size >= 8) break;
  }
  if (pool.size === 0) return null;

  const ranked = rank([...pool.values()], track.durationMs);

  for (const candidate of ranked.slice(0, 4)) {
    const check = await verifyEmbeddable(candidate.videoId);
    // A failed check (network, layout change) is not proof of a bad video —
    // take it anyway rather than dropping a track to a 30-second preview.
    if (!check) return candidate;
    if (check.ok) {
      return { ...candidate, durationMs: check.durationMs || candidate.durationMs };
    }
  }

  return null; // every candidate refuses to embed; the preview will cover it
}

/* ── 3. write it out ─────────────────────────────────────────────────────── */

function serialise(playlistId, playlistName, tracks) {
  const rows = tracks
    .map((t) =>
      [
        "  {",
        `    id: ${JSON.stringify(t.id)},`,
        `    name: ${JSON.stringify(t.name)},`,
        `    artist: ${JSON.stringify(t.artist)},`,
        `    album: ${JSON.stringify(t.album)},`,
        `    image: ${JSON.stringify(t.image)},`,
        `    duration: ${t.duration},`,
        `    spotifyUrl: ${JSON.stringify(t.spotifyUrl)},`,
        `    uri: ${JSON.stringify(t.uri)},`,
        t.youtubeId ? `    youtubeId: ${JSON.stringify(t.youtubeId)},` : null,
        t.youtubeTitle ? `    youtubeTitle: ${JSON.stringify(t.youtubeTitle)},` : null,
        t.previewUrl ? `    previewUrl: ${JSON.stringify(t.previewUrl)},` : null,
        "  },",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  return `// GENERATED by \`npm run sync\` — do not edit by hand.
//
// Playlist: ${playlistName || playlistId}
// https://open.spotify.com/playlist/${playlistId}
//
// ${tracks.length} track${tracks.length === 1 ? "" : "s"}, ${tracks.filter((t) => t.youtubeId).length} with a YouTube match (full-length playback).
// Re-run \`npm run sync\` after changing the playlist.
import type { Track } from "@/lib/types";

export const GENERATED_PLAYLIST_ID = ${JSON.stringify(playlistId)};
export const GENERATED_PLAYLIST_NAME = ${JSON.stringify(playlistName)};

export const GENERATED_TRACKS: Track[] = [
${rows}
];
`;
}

/* ── main ────────────────────────────────────────────────────────────────── */

const ENV_FILE = join(ROOT, ".env.local");
const ENV_KEY = "NEXT_PUBLIC_SPOTIFY_PLAYLIST_ID";

/**
 * One value out of `.env.local`, falling back to the real environment.
 *
 * Deliberately minimal rather than pulling in dotenv: this reads three keys at
 * most, and a dependency that parses credentials is a dependency worth not
 * having. Values are never logged.
 */
function envValue(key) {
  if (existsSync(ENV_FILE)) {
    const m = readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return process.env[key] ?? "";
}

function playlistIdFromEnv() {
  if (existsSync(ENV_FILE)) {
    const m = readFileSync(ENV_FILE, "utf8").match(
      new RegExp(`^${ENV_KEY}\\s*=\\s*(.+)$`, "m"),
    );
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return process.env[ENV_KEY] ?? "";
}

/**
 * Records the playlist in `.env.local` so the running site and the baked
 * catalogue cannot drift apart — a mismatch between them is what makes the app
 * fall back to previews.
 */
function writePlaylistIdToEnv(id) {
  const line = `${ENV_KEY}=${id}`;
  let body = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";

  if (new RegExp(`^${ENV_KEY}\\s*=`, "m").test(body)) {
    if (playlistIdFromEnv() === id) return false; // already correct
    body = body.replace(new RegExp(`^${ENV_KEY}\\s*=.*$`, "m"), line);
  } else {
    body = body.length && !body.endsWith("\n") ? `${body}\n${line}\n` : `${body}${line}\n`;
  }

  writeFileSync(ENV_FILE, body, "utf8");
  return true;
}

const arg = process.argv[2];
const playlistId = parsePlaylistId(arg || playlistIdFromEnv());

if (!playlistId) {
  console.error(`
No playlist given. Pass the one you want, for example:

    npm run sync -- https://open.spotify.com/playlist/4fyTKh4Qlk2yecsIlomofR

A bare id or a spotify:playlist: URI works too, and the playlist must be PUBLIC.
Note there are no angle brackets: PowerShell reserves < for redirection, so a
<placeholder> copied from here fails before npm even runs.

Or set NEXT_PUBLIC_SPOTIFY_PLAYLIST_ID in .env.local and just run \`npm run sync\`.
`);
  process.exit(1);
}

console.log(`\nPlaylist ${playlistId}`);

/**
 * Read the playlist the best way available.
 *
 * The official API is preferred and is the ONLY way to get past 100 tracks, but
 * it needs a signed-in user: an app token answers 403 on `/tracks`, 401 on
 * `/items`, and Spotify strips `tracks` from the playlist object entirely. The
 * credential-free embed is kept as the fallback so a sync still works with no
 * setup — it just cannot see past the first 100.
 */
async function loadPlaylist(id) {
  const wantsLogin = process.argv.includes("--login");
  const noLogin = process.argv.includes("--no-login");
  const config = {
    clientId: envValue("SPOTIFY_CLIENT_ID"),
    clientSecret: envValue("SPOTIFY_CLIENT_SECRET"),
    redirectUri: envValue("SPOTIFY_REDIRECT_URI"),
  };

  if (!noLogin && config.clientId && config.clientSecret && config.redirectUri) {
    try {
      // Only opens a browser when explicitly asked, or when a saved login can
      // be renewed silently.
      const token = await getUserToken(ROOT, config, wantsLogin);
      if (token) {
        const full = await readPlaylistWithToken(id, token);
        if (full.tracks.length) {
          console.log(`  read via the official Spotify API (signed in) — no 100-track limit`);
          return { ...full, maybeTruncated: false, source: "api" };
        }
      }
    } catch (err) {
      console.log(`  official API unavailable: ${err.message}`);
      console.log(`  falling back to the public embed (first 100 tracks only)\n`);
    }
  }

  return readPlaylist(id);
}

const { name, tracks, maybeTruncated, total } = await loadPlaylist(playlistId);

if (!tracks.length) {
  console.error(
    `\nNo tracks. The playlist must be PUBLIC — open it in a private window to check.\n`,
  );
  process.exit(1);
}

console.log(
  `"${name}" — ${tracks.length} track${tracks.length === 1 ? "" : "s"}` +
    (total && total !== tracks.length ? ` of ${total}` : ""),
);

// Say it plainly rather than quietly shipping a partial playlist. This is the
// bug that turned a 250-track playlist into 100 without a word.
if (maybeTruncated) {
  console.log(`
  ⚠  THIS MAY NOT BE THE WHOLE PLAYLIST.

     The public Spotify embed returns at most ${EMBED_TRACK_CAP} tracks, ignores every
     paging parameter, and reports no total — so ${tracks.length} could be the whole
     list, or the first ${EMBED_TRACK_CAP} of many more.

     To read all of it, sign in once:

         npm run sync -- ${playlistId} --login

     That opens Spotify in your browser and remembers the login, so later syncs
     need no browser. Stop \`npm run dev\` first — the login briefly needs port 3000.`);
}

console.log(`\nMatching each track to a YouTube video for full-length playback:\n`);

/**
 * A few tracks at a time, results kept in playlist order.
 *
 * Sequential is far too slow past a handful of songs — a 100-track playlist took
 * a quarter of an hour. Three is deliberate restraint, arrived at the hard way:
 * at six, a 100-track run matched its first 50 tracks and then got throttled into
 * failing 31 of the rest, all of which were plainly on YouTube.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** One line of progress, printed as each track lands. */
function report(position, total, title, video, wantMs, prefix = "") {
  const drift =
    video?.durationMs && wantMs
      ? Math.round((Math.abs(video.durationMs - wantMs) / wantMs) * 100)
      : null;
  console.log(
    `  ${prefix}${String(position).padStart(3)}/${total}` +
      ` ${title.slice(0, 36).padEnd(38)}` +
      (video
        ? `${video.videoId}  ${mmss(video.durationMs).padStart(6)} vs ${mmss(wantMs).padStart(6)}` +
          `  ${drift !== null && drift <= 15 ? "ok" : `${drift}% off`}`
        : "no match yet"),
  );
}

let done = 0;
const out = await mapLimit(tracks, 3, async (t, i) => {
  // The official API already returns artwork and the album name, so only the
  // embed path needs the extra per-track fetch. On a 250-track playlist that is
  // 250 requests saved, and 250 fewer scrapes.
  const [art, video] = await Promise.all([
    t.image ? Promise.resolve({ image: t.image, album: t.album ?? "" }) : albumArt(t.spotifyId),
    findVideo(t),
  ]);

  done++;
  report(done, tracks.length, `[${String(i + 1).padStart(3)}] ${t.title}`, video, t.durationMs);

  return {
    id: t.spotifyId,
    name: t.title,
    artist: t.artist,
    album: art.album,
    image: art.image,
    duration: t.durationMs,
    spotifyUrl: `https://open.spotify.com/track/${t.spotifyId}`,
    uri: `spotify:track:${t.spotifyId}`,
    youtubeId: video?.videoId ?? "",
    youtubeTitle: video?.rawTitle ?? "",
    previewUrl: t.previewUrl,
  };
});

/* ── second pass: retry the ones that did not land ───────────────────────── */

/**
 * Anything unmatched gets one more try, alone and unhurried.
 *
 * Almost every first-pass miss on a long playlist is throttling rather than a
 * missing song, and a track that quietly plays 30 seconds is a bug the listener
 * finds before you do. One at a time, no concurrency, generous waits.
 */
const missed = out
  .map((t, i) => ({ t, i }))
  .filter(({ t }) => !t.youtubeId);

if (missed.length) {
  console.log(
    `\n${missed.length} track${missed.length === 1 ? "" : "s"} did not match. Retrying one at a time` +
      `${throttleEvents ? ` (YouTube pushed back ${throttleEvents}× — that is usually the cause)` : ""}:\n`,
  );

  let recovered = 0;
  for (const [n, { t, i }] of missed.entries()) {
    await sleep(1_200); // space them out; this is the whole point of the pass
    const video = await findVideo(
      { title: t.name, artist: t.artist, durationMs: t.duration },
      true,
    );
    if (video) {
      out[i].youtubeId = video.videoId;
      out[i].youtubeTitle = video.rawTitle;
      recovered++;
    }
    report(n + 1, missed.length, t.name, video, t.duration, "retry ");
  }

  console.log(
    `\n  recovered ${recovered}/${missed.length} on the second pass`,
  );
}

writeFileSync(OUT, serialise(playlistId, name, out), "utf8");
const envChanged = writePlaylistIdToEnv(playlistId);

const full = out.filter((t) => t.youtubeId).length;
const prev = out.filter((t) => !t.youtubeId && t.previewUrl).length;
const dead = out.length - full - prev;

console.log(`
Wrote src/config/catalogue.generated.ts${envChanged ? `\nWrote ${ENV_KEY} into .env.local` : ""}

  ${full}/${out.length} play FULL LENGTH via YouTube${prev ? `\n  ${prev} fall back to a 30s Spotify preview` : ""}${dead ? `\n  ${dead} have no audio at all` : ""}`);

// On a long playlist the per-track lines scroll away, so name the ones that did
// not get a full-length match — those are the only ones worth looking at.
const unmatched = out.filter((t) => !t.youtubeId);
if (unmatched.length) {
  console.log(`\nStill no YouTube match (these play 30 seconds):`);
  for (const t of unmatched) {
    console.log(
      `  - ${t.name.slice(0, 46).padEnd(48)}${t.artist.slice(0, 30)}` +
        `${t.previewUrl ? "" : "   (and no preview either — silent)"}`,
    );
  }
  console.log(`\nRe-running \`npm run sync\` retries them; YouTube's results vary.`);
}

// Say it plainly. A run that was throttled produced a worse catalogue than the
// playlist deserves, and that is worth knowing before shipping it.
if (throttleEvents > 0) {
  console.log(
    `\nnote  YouTube throttled this run ${throttleEvents} time${throttleEvents === 1 ? "" : "s"}.` +
      `${unmatched.length ? "\n      Re-run in a few minutes — the misses above are probably recoverable." : "\n      It was worked around, and every track still matched."}`,
  );
}

console.log("\nRestart the dev server to pick it up.");

if (dead) process.exitCode = 0; // not a failure; the site still runs
