/* Build a media:// URL for a local file served by main/media-protocol.js.
   `w` requests a cached sharp thumbnail at that width. */
export function mediaUrl(absPath: string, w?: number): string {
  return `media://${encodeURI(absPath)}${w ? `?w=${w}` : ''}`;
}
