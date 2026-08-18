/* Build a media:// URL for a local file served by main/media-protocol.js.
   `w` requests a cached sharp thumbnail at that width. */
export function mediaUrl(absPath: string, w?: number): string {
  const escaped = encodeURI(absPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `media://${escaped}${w ? `?w=${w}` : ''}`;
}
