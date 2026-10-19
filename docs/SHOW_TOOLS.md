# Announcements and show timers

Both live in **Show Mode**, next to Cues and Media, and work over whatever is on the wall.

## Announcements (front-of-house calls)

- **Announce** tab: one button per recorded call. Click to play, **Stop** fades it out. One plays at a time, on the show's audio output (Output settings → audio host).
- Ten calls ship with the show, read in a movie-trailer voice (ElevenLabs "David - The Movie Trailer", model v4): doors in 15 / 10 / 5, doors open, show in 10 / 5, show starting, technical difficulties, intermission + restrooms, resuming in 5. Files: `public/media/announcements/`. Technical difficulties is pinned first and red; any call can be pinned or marked urgent in edit mode (✎).
- **Generate**: write a call, pick a voice (▶ plays a sample of each) and the app has ElevenLabs read it; the MP3 goes into the library and becomes a new button. The API key is kept on this computer only (never in the show file). **Import audio** adds your own recordings.
- Media settings (backgrounds, layers, clips, sounds…) open the same library as a picker: thumbnails, search, None.
- A cue can play one: Run sheet → Add action → Lighting & sound → **Announcement**.

## Show timers

- **Timers** tab: Pre-show (5:00) and Intermission (15:00) to start with; add more. Start / Pause, ±1 min, reset, length, and an announcement to play at 0:00. Timers keep running across scenes, TAKEs and an app restart. A running timer shows in the top bar.
- **Show on screen** lays the clock over everything on the wall (hidden during blackout). **On-screen look** sets one style for all of them: position, size, font (any font installed on the computer), colours, box, name on/off.
- **On the wall, designed**: a title with a timer: Build → Components → Add → **Countdown**, or a title's *Countdown* setting. Write `{time}` where the clock goes ("WE'LL BE BACK IN {time}").
- **Make a scene** on a timer card adds a holding scene with that countdown whose first cue starts the clock.
- A cue can start / pause / reset a timer: Run sheet → Add action → Show → **Show timer**.
