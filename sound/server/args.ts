// Command-line options → environment, evaluated before any other module of the service (main.ts imports
// it first), so an embedding shell (e.g. a Tauri sidecar) can pass everything as arguments:
//   --data <dir>  --dist <dir>  --http-port <n>  --osc-port <n>  --desk-readonly
// Env equivalents: SOUND_DATA_DIR, SOUND_DIST_DIR, SOUND_HTTP_PORT, SOUND_OSC_PORT, SOUND_DESK_READONLY=1.

const map: Record<string, string> = { "--data": "SOUND_DATA_DIR", "--dist": "SOUND_DIST_DIR", "--http-port": "SOUND_HTTP_PORT", "--osc-port": "SOUND_OSC_PORT", "--version-string": "SOUND_APP_VERSION" };
const argv = process.argv;
for (let i = 2; i < argv.length; i++) {
  const [flag, inline] = argv[i].split("=", 2);
  const env = map[flag];
  if (env) {
    const v = inline ?? argv[++i];
    if (v) process.env[env] = v;
  } else if (flag === "--desk-readonly") process.env.SOUND_DESK_READONLY = "1";
}
export {};
