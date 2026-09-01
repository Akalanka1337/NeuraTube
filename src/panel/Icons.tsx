/**
 * Inline SVG icons as Preact components.
 *
 * Rendered as JSX rather than injected markup: JSX compiles to
 * `createElement` calls, which are not Trusted Types sinks, so these keep
 * working under YouTube's enforced CSP. An SVG sprite loaded from a
 * web-accessible resource would also work but costs a fetch and a WAR entry.
 */

import type { JSX } from 'preact';

interface IconProps {
  readonly title?: string;
}

function wrap(path: JSX.Element, title?: string): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}

export function IconMinimise({ title }: IconProps): JSX.Element {
  return wrap(<path d="M6 12h12" />, title);
}

export function IconClose({ title }: IconProps): JSX.Element {
  return wrap(<path d="M6 6l12 12M18 6L6 18" />, title);
}

export function IconInfo({ title }: IconProps): JSX.Element {
  return wrap(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>,
    title,
  );
}
