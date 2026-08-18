import type { BackdropId, FramingId } from './types';
import type { Tone as BadgeTone } from './components/ds';

export const BACKDROPS: { id: BackdropId; label: string; group: 'neutral' | 'branded'; swatch: string }[] = [
  { id: 'white', label: 'White seamless', group: 'neutral', swatch: 'radial-gradient(circle at 50% 35%, #FFFFFF, #F1F1F3 62%, #DEDEE3)' },
  { id: 'grey', label: 'Mid grey', group: 'neutral', swatch: 'radial-gradient(circle at 50% 35%, #9A9DA1, #7A7D80 58%, #4E5154)' },
  { id: 'navy', label: 'Corporate navy', group: 'neutral', swatch: 'radial-gradient(circle at 50% 35%, #2C4763, #1A2A3D 60%, #0E1724)' },
  { id: 'outdoor-soft', label: 'Outdoor bokeh', group: 'neutral', swatch: 'linear-gradient(135deg, #3E5B3A, #6E8A55 45%, #C6B98A)' },
  { id: 'office-soft', label: 'Soft office', group: 'neutral', swatch: 'linear-gradient(120deg, #E8E3DB, #CFC7BB 55%, #A79C8C)' },
  { id: 'turbo', label: 'Turbo branded', group: 'branded', swatch: 'linear-gradient(100deg, #0A0A0B, #141416 62%, #F2A900)' },
  { id: 'stage', label: 'Stage', group: 'branded', swatch: 'linear-gradient(120deg, #0C0C12, #1E1B33 55%, #6A5CA8)' },
  { id: 'event-bokeh', label: 'Event floor', group: 'branded', swatch: 'radial-gradient(circle at 30% 40%, rgba(242,169,0,0.85) 0 6%, transparent 7%), radial-gradient(circle at 70% 65%, rgba(242,169,0,0.6) 0 5%, transparent 6%), linear-gradient(135deg, #14100B, #2A2118)' },
];

export const FRAMINGS: { id: FramingId; label: string; note?: string }[] = [
  { id: 'chest-up', label: 'Chest up' },
  { id: 'shoulders-up', label: 'Shoulders up' },
  { id: 'head-tight', label: 'Head tight' },
  { id: 'original', label: 'Original framing', note: 'Pins a concrete aspect ratio and unlocks the garment pixel-lock.' },
];

export const backdropLabel = (id: BackdropId): string =>
  BACKDROPS.find((b) => b.id === id)?.label ?? id;

export const shootStatusTone = (s: string): BadgeTone =>
  s === 'live' ? 'info' : s === 'delivered' ? 'success' : s === 'held' ? 'warning' : 'neutral';

export const batchStatusTone = (s: string): BadgeTone =>
  s === 'held' ? 'warning' : s === 'processing' || s === 'queued' ? 'info'
  : s === 'done' ? 'success' : s === 'failed' ? 'danger' : 'neutral';

export const deliveryLabel = (s: string): { label: string; tone: BadgeTone } =>
  s === 'link-sent' ? { label: 'Link sent', tone: 'success' }
  : s === 'opened' ? { label: 'Opened', tone: 'viewed' }
  : s === 'bounced' ? { label: 'Bounced', tone: 'danger' }
  : { label: 'Not sent', tone: 'neutral' };

export const usd = (n: number): string => `$${n.toFixed(2)}`;

export function optsSummary(o: { backdrops: BackdropId[]; framing: FramingId; keepClothing: boolean; portrait: boolean; square: boolean; cutout: boolean; print8k: boolean }): string {
  const parts = [
    o.backdrops.map(backdropLabel).join(' + '),
    FRAMINGS.find((f) => f.id === o.framing)?.label ?? o.framing,
    o.keepClothing ? 'keep clothing' : 'restyled attire',
    [o.portrait && '4:5', o.square && '1:1', o.cutout && 'TP PNG', o.print8k && '8K'].filter(Boolean).join(' + '),
  ];
  return parts.filter(Boolean).join(' · ');
}

export const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
