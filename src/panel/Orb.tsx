import type { JSX } from 'preact';

export interface OrbProps {
  readonly onExpand: () => void;
}

/** Collapsed state: a 48x48 button that restores the panel. */
export function Orb({ onExpand }: OrbProps): JSX.Element {
  return (
    <button
      type="button"
      class="orb"
      onClick={onExpand}
      title="Open NeuraTube (Alt+N)"
      aria-label="Open NeuraTube panel"
    >
      N
    </button>
  );
}
