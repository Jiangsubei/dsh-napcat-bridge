import React from 'react';
import * as DshPrimitives from '@deepseek-ai/dsh-client-ui-primitives';

export function IconUpload(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

export function IconEdit(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function IconPlus(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconTrash(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
    </svg>
  );
}

export function IconBan(props: { size?: number }): React.JSX.Element {
  const size = props.size ?? 32;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

function resolveChevronDownIcon(): React.ComponentType<{ className?: string }> {
  try {
    const P = DshPrimitives as any;
    if (typeof P?.IconChevronDownOutlineMedium === 'function') return P.IconChevronDownOutlineMedium;
    if (typeof P?.IconChevronDownOutlineRegular === 'function') return P.IconChevronDownOutlineRegular;
  } catch {
    // ignore
  }
  return () => null;
}

export const SafeIconChevronDown: React.ComponentType<{ className?: string }> = resolveChevronDownIcon();
