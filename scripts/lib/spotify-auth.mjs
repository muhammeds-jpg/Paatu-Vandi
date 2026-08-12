/**
 * A one-off Spotify login for command-line tools.
 *
 * WHY THIS EXISTS: Spotify will not let an app token read a playlist's tracks.
 * `/v1/playlists/{id}/tracks` answers 403 and `/items` answers
 * "401 Valid user authentication required", and the `tracks` object is stripped
 * from the playlist response entirely. The public embed payload works without
 * any credentials but returns AT MOST 100 tracks, ignores every pagination
 * parameter, and carries no total — so a 250-track playlist silently becomes
 * 100 with nothing to warn you.
 *
 * A logged-in user token is the only way to read a playlist in full.
 *
 * It reuses the redirect URI already registered for the web app
 * (`http://127.0.0.1:3000/auth/spotify/callback`), so there is nothing to add in
 * the Spotify dashboard. The trade is that port 3000 must be free while the
 * login happens — stop `npm run dev` first.
 *
 * The refresh token is cached so this is a one-time browser step; later syncs
 * renew silently.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ACCOUNTS = "https://accounts.spotify.com";

/** Only what reading a playlist needs. Deliberately NOT the playback scopes. */
const SCOPES = ["playlist-read-private", "playlist-read-collaborative"].join(" ");

/* ── the cached refresh token ────────────────────────────────────────────── */

/**
 * Holds a REFRESH TOKEN, which is long-lived and grants access to the account's
 * playlists. It is a credential: `.gitignore` must cover it, and it must never
 * be committed or pasted anywhere.
 */
export const TOKEN_CACHE = ".spotify-token.json";

function readCache(root) {
  const path = `${root}/${TOKEN_CACHE}`;
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed?.refresh_token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(root, data) {
  try {
    writeFileSync(`${root}/${TOKEN_CACHE}`, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Losing the cache only costs one more browser login.
  }
}

/* ── token exchange ──────────────────────────────────────────────────────── */

function basic(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function exchange(config, body) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic(config.clientId, config.clientSecret)}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Spotify refused the token request (${res.status}): ${json.error_description ?? json.error ?? "unknown"}`,
    );
  }
  return json;
}

async function refresh(config, refreshToken) {
  return exchange(
    config,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  );
}

/* ── the browser round trip ──────────────────────────────────────────────── */

function openBrowser(url) {
  // Windows `start` needs an empty title argument first, or a quoted URL is
  // swallowed as the window title and nothing opens.
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function login(config) {
  const url = new URL(config.redirectUri);
  const port = Number(url.port || 80);
  const state = randomBytes(16).toString("hex");

  const authorize =
    `${ACCOUNTS}/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      scope: SCOPES,
      redirect_uri: config.redirectUri,
      state,
      // Force the consent screen so switching accounts is possible.
      show_dialog: "true",
    }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const incoming = new URL(req.url, `http://${req.headers.host}`);
      if (incoming.pathname !== url.pathname) {
        res.writeHead(404).end("not the callback");
        return;
      }

      const returned = incoming.searchParams.get("state");
      const error = incoming.searchParams.get("error");
      const got = incoming.searchParams.get("code");

      const done = (message, ok) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Spotify</title>` +
            `<body style="font:16px/1.6 system-ui;background:#0b0908;color:#f4efe6;display:grid;place-items:center;height:100vh;margin:0">` +
            `<div style="text-align:center"><p style="font-size:20px">${message}</p>` +
            `<p style="color:#8d8377">You can close this tab and return to the terminal.</p></div>`,
        );
        server.close();
      };

      if (error) {
        done(`Spotify returned: ${error}`, false);
        reject(new Error(`Spotify login was refused: ${error}`));
        return;
      }
      // The state check is the CSRF guard; a mismatch means this response did
      // not come from the request we started.
      if (returned !== state) {
        done("State mismatch — login rejected.", false);
        reject(new Error("State mismatch: the callback did not match this login attempt."));
        return;
      }
      if (!got) {
        done("No authorization code came back.", false);
        reject(new Error("No authorization code in the callback."));
        return;
      }

      done("Signed in. Reading your playlist…", true);
      resolve(got);
    });

    server.on("error", (err) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use — the dev server is probably running.\n` +
                `        Stop \`npm run dev\`, run this again, then start it back up.`,
            )
          : err,
      );
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`\n  Opening Spotify to sign in…`);
      console.log(`  If your browser does not open, paste this in:\n\n    ${authorize}\n`);
      openBrowser(authorize);
    });

    // Do not hang forever if the tab is closed.
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the Spotify login (2 minutes)."));
    }, 120_000).unref();
  });

  return exchange(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }).toString(),
  );
}

/* ── the public entry point ──────────────────────────────────────────────── */

/**
 * Returns a user access token, reusing the cached refresh token when possible.
 *
 * @param root       project root, where the token cache lives
 * @param config     { clientId, clientSecret, redirectUri }
 * @param allowLogin when false, returns null instead of opening a browser —
 *                   so an unattended run degrades rather than blocking on a
 *                   prompt nobody is there to answer.
 */
export async function getUserToken(root, config, allowLogin = true) {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) return null;

  const cached = readCache(root);
  if (cached?.refresh_token) {
    try {
      const renewed = await refresh(config, cached.refresh_token);
      // Spotify only sometimes returns a new refresh token; keep the old one
      // when it does not, or the next run silently falls back to a login.
      writeCache(root, {
        refresh_token: renewed.refresh_token ?? cached.refresh_token,
        obtained_at: new Date().toISOString(),
      });
      return renewed.access_token;
    } catch {
      console.log("  (the saved Spotify login expired — signing in again)");
    }
  }

  if (!allowLogin) return null;

  const fresh = await login(config);
  if (fresh.refresh_token) {
    writeCache(root, {
      refresh_token: fresh.refresh_token,
      obtained_at: new Date().toISOString(),
    });
  }
  return fresh.access_token;
}

/**
 * Every track in a playlist, via the official API.
 *
 * `/items` rather than `/tracks`: the latter answers 403 for this app, while
 * `/items` works with a user token. Pages 100 at a time and follows `next`
 * until the list is exhausted — which is the entire point, since the public
 * embed stops dead at 100.
 */
export async function readPlaylistWithToken(playlistId, token) {
  const collected = [];
  let name = "";
  let total = null;

  const meta = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (meta.ok) {
    const json = await meta.json();
    name = json.name ?? "";
    total = json.tracks?.total ?? null;
  }

  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&offset=0`;
  while (url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Spotify returned ${res.status} reading the playlist: ${body.slice(0, 160)}`);
    }
    const page = await res.json();
    total ??= page.total ?? null;

    for (const row of page.items ?? []) {
      const t = row?.item ?? row?.track;
      if (!t || row.is_local || (t.type && t.type !== "track")) continue;
      collected.push({
        spotifyId: t.id,
        title: String(t.name ?? "").trim(),
        artist: (t.artists ?? []).map((a) => a.name).join(", "),
        durationMs: Number(t.duration_ms ?? 0),
        // The official API omits preview_url for many tracks; absent is fine,
        // the track simply has no 30-second fallback.
        previewUrl: t.preview_url ?? "",
        image:
          t.album?.images?.find((i) => i.width === 640)?.url ?? t.album?.images?.[0]?.url ?? "",
        album: t.album?.name ?? "",
      });
    }
    url = page.next ?? null;
  }

  return { name, tracks: collected, total };
}
