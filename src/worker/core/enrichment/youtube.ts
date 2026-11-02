import { localOverride, readSecret } from "../env";
import { fetchWithRetry } from "../http";
import type { FailureScope } from "./failures";
import { normaliseYouTube, type NormalisedProfile } from "./normalise";

// YouTube Data API v3, quota-aware (FR-CORE-11): channel by handle, then its uploads playlist, then
// video statistics. 1 unit per call; search.list is never used in refresh paths (capped at 100 calls a day).
const ytApi = (env: Env) => localOverride(env, "YOUTUBE_API_URL", "https://www.googleapis.com/youtube/v3");
const RECENT_VIDEOS = 12;

export type YouTubeResult = { profile: NormalisedProfile; raw: unknown } | { error: string; scope: FailureScope };

// 400 and 404 are about what was asked for; 401, 403 (quota or key), 429 and 5xx would hit any creator
const scopeOf = (status: number): FailureScope => (status === 400 || status === 404 ? "handle" : "global");

export async function fetchYouTubeProfile(env: Env, handle: string): Promise<YouTubeResult> {
  const key = readSecret(env, "YOUTUBE_API_KEY");
  if (!key) return { error: "YOUTUBE_API_KEY is not set", scope: "global" };
  const q = (path: string, params: Record<string, string>) =>
    fetchWithRetry(`${ytApi(env)}/${path}?${new URLSearchParams({ ...params, key }).toString()}`);

  // Error messages never include the request URL, because it carries the key
  const chRes = await q("channels", { part: "snippet,statistics,contentDetails", forHandle: handle.replace(/^@?/, "@") });
  if (!chRes.ok) return { error: `channels.list returned HTTP ${chRes.status}`, scope: scopeOf(chRes.status) };
  const channel = ((await chRes.json()) as { items?: unknown[] }).items?.[0];
  if (!channel) return { error: "no channel found for this handle", scope: "handle" };

  // BR-CORE-2 (finding 17): if either follow-up call fails, the job fails and the last good snapshot stays. A
  // snapshot with no recent videos would read as a channel with no views at all.
  let videos: unknown[] = [];
  const uploads = (channel as { contentDetails?: { relatedPlaylists?: { uploads?: string } } }).contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const plRes = await q("playlistItems", { part: "contentDetails", maxResults: String(RECENT_VIDEOS), playlistId: uploads });
    // A channel that has never uploaded can answer 404 for its uploads list: no videos, not a failure
    if (!plRes.ok && plRes.status !== 404) return { error: `playlistItems.list returned HTTP ${plRes.status}`, scope: "global" };
    const ids = plRes.ok
      ? (((await plRes.json()) as { items?: { contentDetails?: { videoId?: string } }[] }).items ?? []).flatMap((i) => (i.contentDetails?.videoId ? [i.contentDetails.videoId] : []))
      : [];
    if (ids.length) {
      const vRes = await q("videos", { part: "snippet,statistics", id: ids.join(",") });
      if (!vRes.ok) return { error: `videos.list returned HTTP ${vRes.status}`, scope: "global" };
      videos = ((await vRes.json()) as { items?: unknown[] }).items ?? [];
    }
  }
  const profile = normaliseYouTube(handle, channel, videos);
  return profile ? { profile, raw: { channel, videos } } : { error: "unrecognised channel payload", scope: "handle" };
}

// ③ post refresh: statistics for specific videos, 1 unit per call of up to 50 IDs. A video missing from
// the response is deleted or private (BR-CO-1).
export type YouTubeVideoStats = { id: string; views: number | null; likes: number | null; comments: number | null };

export async function fetchYouTubeVideos(env: Env, ids: string[]): Promise<{ videos: YouTubeVideoStats[]; raw: unknown[] } | { error: string }> {
  const key = readSecret(env, "YOUTUBE_API_KEY");
  if (!key) return { error: "YOUTUBE_API_KEY is not set" };
  const videos: YouTubeVideoStats[] = [];
  const raw: unknown[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({ part: "statistics,status", id: ids.slice(i, i + 50).join(","), key });
    const res = await fetchWithRetry(`${ytApi(env)}/videos?${params.toString()}`);
    if (!res.ok) return { error: `videos.list returned HTTP ${res.status}` };
    const items = ((await res.json()) as { items?: { id?: string; statistics?: Record<string, string | undefined> }[] }).items ?? [];
    for (const item of items) {
      if (!item.id) continue;
      raw.push(item);
      const n = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
      videos.push({ id: item.id, views: n(item.statistics?.viewCount), likes: n(item.statistics?.likeCount), comments: n(item.statistics?.commentCount) });
    }
  }
  return { videos, raw };
}
