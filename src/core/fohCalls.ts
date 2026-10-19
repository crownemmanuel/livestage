// Front-of-house calls that ship with the show: recorded in a movie-trailer voice
// (ElevenLabs "Movie Trailer Voice") and served from /media/announcements.

import type { Announcement, Asset } from "./types";

const CALLS: [id: string, name: string][] = [
  ["doors-15", "Doors open in 15 min"],
  ["doors-10", "Doors open in 10 min"],
  ["doors-5", "Doors open in 5 min"],
  ["doors-open", "Doors are open: find your seats"],
  ["show-10", "Show begins in 10 min"],
  ["show-5", "Show begins in 5 min"],
  ["show-starting", "Show is about to begin, doors closing"],
  ["technical", "Technical difficulties"],
  ["intermission", "15-minute intermission + restrooms"],
  ["resume-5", "Show resumes in 5 min"],
];

export const FOH_ASSETS: Asset[] = CALLS.map(([id, name]) => ({ id: `asset_foh_${id}`, name: `Announcement · ${name}.mp3`, type: "audio", url: `/media/announcements/${id}.mp3`, builtIn: true }));

export const fohAnnouncements = (): Announcement[] => CALLS.map(([id, name]) => ({ id: `ann_foh_${id}`, name, assetId: `asset_foh_${id}`, volume: 1 }));

export const FOH_CALLS = "foh-calls-1";
