import React from 'react';
import './ds.css';

/* ---------- Button ---------- */

export function Button({
  variant = 'secondary', size = 'md', children, className = '', ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'dark' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button className={`ds-btn ${variant} ${size} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/* ---------- Badge ---------- */

export type Tone = 'success' | 'info' | 'viewed' | 'warning' | 'danger' | 'neutral';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`ds-badge ${tone}`}>{children}</span>;
}

/* ---------- StatTile ---------- */

export function StatTile({
  label, value, sub, hero = false,
}: { label: string; value: React.ReactNode; sub?: React.ReactNode; hero?: boolean }) {
  return (
    <div className={`ds-stat${hero ? ' hero' : ''}`}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub != null && <span className="sub">{sub}</span>}
    </div>
  );
}

/* ---------- Switch ---------- */

export function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`ds-switch${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function SwitchRow({
  title, desc, on, onChange, disabled,
}: { title: string; desc?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <div>
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      <Switch on={on} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/* ---------- Input ---------- */

export function Field({
  label, hint, error, children,
}: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <label className={`ds-field${error ? ' error' : ''}`}>
      <span className="lbl">{label}</span>
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Input({
  label, hint, error, ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <Field label={label} hint={hint} error={error}>
      <input {...rest} />
    </Field>
  );
}

/* ---------- Icon (Lucide-style inline SVG, stroke 1.75) ---------- */

export function Icon({ paths, size = 24 }: { paths: string[]; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/* Nav + common icon path sets (from the v2 design prototype). */
export const ICONS: Record<string, string[]> = {
  shoots: ['M3 7l9-4 9 4-9 4-9-4z', 'M3 12l9 4 9-4', 'M3 17l9 4 9-4'],
  checkin: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M19 8v6', 'M22 11h-6'],
  capture: ['M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8'],
  review: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  processing: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  gallery: ['M16 16l-4-4-4 4', 'M12 12v9', 'M20.4 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 3 14.9'],
  delivery: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  qr: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3z', 'M20 14h1v1h-1z', 'M14 20h1v1h-1z', 'M20 20h1v1h-1z'],
  plus: ['M12 5v14', 'M5 12h14'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
};
