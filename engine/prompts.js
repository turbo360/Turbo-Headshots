// Headshot prompt construction — ported verbatim from
// turbo-enhance/src/lib/prompts.ts (the battle-tested wording, especially the
// BRANDING IS SACRED block; do not reword without re-testing on real logos).

const BACKDROP_PROMPTS = {
  white:
    'clean, evenly-lit seamless white studio backdrop with the subject softly separated from the wall by a faint shadow gradient',
  grey:
    'neutral mid-grey seamless studio backdrop (#7a7d80) with a smooth subtle vignette darkening toward the edges',
  navy:
    'deep corporate navy backdrop (#1a2a3d) with a gentle radial gradient that places the subject in a soft pool of light',
  'outdoor-soft':
    'softly-blurred outdoor environment in the background (parks, distant buildings) with creamy natural bokeh, late-afternoon golden warmth, shallow depth of field',
  'office-soft':
    'softly-blurred contemporary office interior in the background (warm wood, soft glass) with smooth bokeh and natural ambient light',
  turbo:
    'deep dark backdrop with a subtle warm orange edge light from camera-right and a soft black-to-charcoal radial gradient, modern editorial mood',
  stage:
    'softly-blurred warm stage lighting in the background as if the subject is just off-camera at a keynote — orange and amber bokeh points, gentle haze, cinematic depth',
  'event-bokeh':
    'softly-blurred event-floor bokeh in the background — a mix of warm and cool fairy-light points, slight haze, evening conference atmosphere',
};

const CROP_PROMPTS = {
  'chest-up':
    'frame as a classic corporate headshot from mid-chest upward, with comfortable space around the head, subject centred',
  'shoulders-up':
    'tighter framing from the shoulders upward, with confident eye contact and minimal headroom',
  'head-tight':
    'tight portrait framing of the face and neck, head and shoulders only, minimal background visible',
  // The pixel-lock mode: no reframe means the pipeline can composite the
  // ORIGINAL clothing pixels back over the output afterwards.
  original:
    "keep the subject's exact framing, scale, position and pose from the input photo — do not re-frame, crop, zoom, rotate or re-pose the subject in any way; only the backdrop and lighting change",
};

function buildHeadshotPrompt(backdrop, crop, keepGlasses, keepClothing = true, options = {}) {
  const glasses = keepGlasses
    ? 'If the subject is wearing glasses, keep the glasses exactly as in the input (same frame shape, same colour, same position). Do not add or remove glasses.'
    : 'Preserve eyewear exactly as it appears in the input image. Do not add or remove glasses.';

  const wardrobe = keepClothing
    ? 'WARDROBE — KEEP ORIGINAL CLOTHING: the subject must wear the exact same clothes as in the input photo. Preserve the same garments, colours, patterns, collar/neckline, buttons, logos and fabric texture, and the way the clothing sits and creases. Do NOT change, restyle, smarten, swap, recolour or replace any clothing — only relight it to match the new studio lighting. ' +
      'BRANDING IS SACRED: ALL logos, brand marks, embroidery, printed graphics and lettering on the clothing must remain character-for-character and pixel-for-pixel identical to the input — never re-spell, re-letter, re-font, re-size, warp, blur, sharpen-invent or redraw any logo or text on a garment. If any part of a logo is unclear, reproduce it exactly as it appears rather than guessing. '
    : 'WARDROBE: dress the subject in clean, well-fitted professional business attire suitable for a corporate headshot (e.g. a tailored blazer or a crisp collared shirt) in neutral professional colours, rendered with realistic fabric and natural creases. Keep it believable for this person. ';

  const brandingRef = options.hasBrandingReference
    ? "The second input image is a hi-resolution close-up of the subject's garment and its branding, provided as the authoritative reference: every logo, emblem and letter on the clothing in your output must match that close-up character-for-character. "
    : '';

  const retryLine = options.brandingRetry
    ? 'IMPORTANT: a previous attempt altered the garment branding. This attempt must reproduce the clothing logos and lettering EXACTLY as in the reference — treat the garment area as read-only pixels that are merely relit. '
    : '';

  return (
    'Re-render this photo as a professional corporate headshot. ' +
    `Background: ${BACKDROP_PROMPTS[backdrop]}. ` +
    `Framing: ${CROP_PROMPTS[crop]}. ` +
    'Lighting: soft, large key light from camera-left (~45°), gentle fill from camera-right, subtle rim light separating the subject from the backdrop. ' +
    'Skin: polished but natural — keep real skin texture, pores, and asymmetric expressions; do not smooth into plastic. ' +
    'Eyes sharp and well-lit with a small natural catchlight. Mouth and jaw relaxed, professional but warm. ' +
    'CRITICAL IDENTITY: keep the exact same person. Same face geometry, same age, same ethnicity, same hairstyle and colour, same facial hair (or lack thereof), same expression character. Do not slim, de-age, or change facial features. ' +
    `${wardrobe}` +
    `${brandingRef}` +
    `${retryLine}` +
    `${glasses} ` +
    "Output: high-resolution, sharp focus on the eyes, cinematic but commercial. Do not add text, logos, watermarks, jewellery, or accessories that aren't in the original."
  );
}

module.exports = { BACKDROP_PROMPTS, CROP_PROMPTS, buildHeadshotPrompt };
