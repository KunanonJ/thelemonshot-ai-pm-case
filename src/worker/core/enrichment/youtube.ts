import { readSecret } from "../env";
import { fetchWithRetry } from "../http";
import { normaliseYouTube, type NormalisedProfile } from "./normalise";

// YouTube Data API v3, quota-aware (FR-CORE-11): channel by handle, then its uploads playlist, then
// video statistics. 1 unit per call; search.list is never used in refresh paths (capped at 100 calls a day).
const YT_API = "https://www.googleapis.com/youtube/v3";
const RECENT_VIDEOS = 12;

export type YouTubeResult = { profile: NormalisedProfile; raw: unknown } | { error: string };

export async function fetchYouTubeProfile(env: Env, handle: string): Promise<YouTubeResult> {
  const key = readSecret(env, "YOUTUBE_API_KEY");
  if (!key) return { error: "YOUTUBE_API_KEY is not set" };
  const q = (path: string, params: Record<string, string>) =>
    fetchWithRetry(`${YT_API}/${path}?${new URLSearchParams({ ...params, key }).toString()}`);

  // Error messages never include the request URL, because it carries the key
  const chRes = await q("channels", { part: "snippet,statistics,contentDetails", forHandle: handle.replace(/^@?/, "@") });
  if (!chRes.ok) return { error: `channels.list returned HTTP ${chRes.status}` };
  const channel = ((await chRes.json()) as { items?: unknown[] }).items?.[0];
  if (!channel) return { error: "no channel found for this handle" };

  let videos: unknown[] = [];
  const uploads = (channel as { contentDetails?: { relatedPlaylists?: { uploads?: string } } }).contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const plRes = await q("playlistItems", { part: "contentDetails", maxResults: String(RECENT_VIDEOS), playlistId: uploads });
    if (plRes.ok) {
      const ids = (((await plRes.json()) as { items?: { contentDetails?: { videoId?: string } }[] }).items ?? []).flatMap((i) =>
        i.contentDetails?.videoId ? [i.contentDetails.videoId] : [],
      );
      if (ids.length) {
        const vRes = await q("videos", { part: "snippet,statistics", id: ids.join(",") });
        if (vRes.ok) videos = ((await vRes.json()) as { items?: unknown[] }).items ?? [];
      }
    }
  }
  const profile = normaliseYouTube(handle, channel, videos);
  return profile ? { profile, raw: { channel, videos } } : { error: "unrecognised channel payload" };
}
