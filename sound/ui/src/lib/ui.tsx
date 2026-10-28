// Small shared pieces: icons, the character avatar (photo or the mock-up's placeholder), pills.

import type { ReactNode } from "react";
import { AVATAR_PALETTE, type Gender } from "../../../server/model.ts";

const ICONS = {
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>,
  micOff: <><path d="M2 2l20 20" /><path d="M9 9v2a3 3 0 0 0 5.1 2.1" /><path d="M15 9.3V6a3 3 0 0 0-5.9-.6" /><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11.3 5.5" /><path d="M12 18v3" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  play: <path d="M7 4v16l13-8z" />,
  next: <><path d="M5 4v16l11-8z" /><path d="M19 5v14" /></>,
  stop: <rect x="5" y="5" width="14" height="14" rx="3" />,
  sparkle: <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  warn: <><path d="M12 3l10 18H2z" /><path d="M12 10v4" /><path d="M12 17.5v.5" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  sync: <><path d="M4 4v6h6" /><path d="M20 20v-6h-6" /><path d="M20 10a8 8 0 0 0-14.3-4.9L4 10M4 14a8 8 0 0 0 14.3 4.9L20 14" /></>,
  people: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M17 4a4 4 0 0 1 0 8" /><path d="M22 21a7 7 0 0 0-4-6.3" /></>,
  desk: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9h2M7 13h2M11 9h6M11 13h6" /></>,
  phone: <><rect x="7" y="2" width="10" height="20" rx="3" /><path d="M11 18h2" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  import: <><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 20h16" /></>,
  music: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2" /></>,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, stroke = 2.4, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {ICONS[name]}
    </svg>
  );
}

export interface AvatarChar {
  name: string;
  gender: Gender;
  palette: number;
  photo?: string | null;
  thumb?: string | null;
}

/** Photo when there is one (thumb on the cloud page), else the placeholder figure from the mock-up. */
export function Avatar({ c, size, ring, photoBase = "/photos/" }: { c: AvatarChar; size: number; ring?: string; photoBase?: string | null }) {
  const p = AVATAR_PALETTE[c.palette % AVATAR_PALETTE.length];
  const src = c.photo && photoBase !== null ? photoBase + c.photo : c.thumb || null;
  const female = c.gender === "female";
  return (
    <span className="block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size, boxShadow: ring ? `0 0 0 4px ${ring}` : undefined, background: p.bg }}>
      {src ? (
        <img src={src} alt="" width={size} height={size} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <svg width="100%" height="100%" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="50" fill={p.bg} />
          {female && <path d="M27 50 C25 22 75 22 73 50 L79 92 L21 92 Z" fill={p.hair} />}
          <path d="M14 104 C16 80 32 71 50 71 C68 71 84 80 86 104 Z" fill={p.robe} />
          <rect x="44" y="58" width="12" height="15" rx="5" fill="#A9714B" />
          <ellipse cx="50" cy="45" rx="15" ry="17" fill="#A9714B" />
          {female ? (
            <path d="M34 44 C33 25 67 25 66 44 C61 34 39 34 34 44 Z" fill={p.hair} />
          ) : (
            <>
              <path d="M35 41 C35 26 65 26 65 41 C60 33 40 33 35 41 Z" fill={p.hair} />
              <path d="M35 47 C37 67 63 67 65 47 C60 57 40 57 35 47 Z" fill={p.hair} />
            </>
          )}
        </svg>
      )}
    </span>
  );
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />;
}

export function Pill({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-2 rounded-full bg-card px-3.5 py-2 text-sm font-extrabold">
      <Dot color={color} />
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[13px] font-extrabold tracking-[1.5px] text-muted uppercase">{children}</div>;
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
