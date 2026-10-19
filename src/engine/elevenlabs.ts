// ElevenLabs text-to-speech for announcements. The API key is kept on this computer only
// (never in the show file), and requests go straight from the app to api.elevenlabs.io.

const KEY = "sls.elevenlabs.key";
const API = "https://api.elevenlabs.io/v1";

export function getElevenKey(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setElevenKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export interface Voice {
  id: string;
  name: string;
  note?: string;
}

/** Deep trailer voices from the ElevenLabs library that suit house calls. */
export const TRAILER_VOICES: Voice[] = [
  { id: "laTmoAT4stwoPzthxjZT", name: "David · The Movie Trailer", note: "the show's announcer (built-in calls)" },
  { id: "9GVWvaD23xXLseHJlxy8", name: "Movie Trailer Voice", note: "the classic trailer read" },
  { id: "JJCR1UICgHnHljtvu5uF", name: "Don · Epic trailer & documentary", note: "deep, powerful" },
  { id: "mq6RH3bgBY9BDzvWeMZk", name: "Flavio · Deep & authoritative", note: "calm, gravelly" },
  { id: "NgBYGKDDq2Z8Hnhatgma", name: "Atlas Pro · Deep narrator", note: "warm, clear" },
];

export const TTS_MODELS = [
  { value: "eleven_multilingual_v2", label: "Multilingual v2 (steady, natural)" },
  { value: "eleven_v3", label: "v3 (most expressive)" },
  { value: "eleven_turbo_v2_5", label: "Turbo v2.5 (fast)" },
];

async function fail(r: Response): Promise<never> {
  let msg = `${r.status}`;
  try {
    const j = await r.json();
    msg = j?.detail?.message ?? j?.detail ?? msg;
  } catch {
    /* not JSON */
  }
  throw new Error(r.status === 401 ? "The API key was not accepted." : `ElevenLabs said: ${msg}`);
}

/** Voices saved in the account (its own and added library voices). */
export async function accountVoices(key: string): Promise<Voice[]> {
  const r = await fetch(`${API}/voices`, { headers: { "xi-api-key": key } });
  if (!r.ok) return fail(r);
  const j = (await r.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  return (j.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, note: [v.labels?.gender, v.labels?.accent].filter(Boolean).join(", ") || undefined }));
}

/** Speak `text` and return the MP3 bytes. */
export async function speak(key: string, voiceId: string, text: string, modelId: string): Promise<Uint8Array> {
  const r = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true } }),
  });
  if (!r.ok) return fail(r);
  return new Uint8Array(await r.arrayBuffer());
}
