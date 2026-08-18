// Entry switch: v2 (operations cockpit) by default; TURBO_V1=1 boots the
// legacy single-page app (kept as a mid-shoot safety net until v2 has run a
// full real shoot).
if (process.env.TURBO_V1 === '1') {
  require('./main-v1');
} else {
  require('./main-v2');
}
