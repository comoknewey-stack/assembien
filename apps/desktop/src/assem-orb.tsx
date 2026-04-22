import type { ReactNode } from 'react';

export type AssemOrbState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'processing'
  | 'thinking'
  | 'speaking'
  | 'task_running'
  | 'paused'
  | 'degraded'
  | 'error';

interface AssemOrbProps {
  state: AssemOrbState;
  label: string;
  diagnostic?: ReactNode;
  size?: 'compact' | 'hero';
  className?: string;
}

export function AssemOrb({
  state,
  label,
  diagnostic,
  size = 'hero',
  className
}: AssemOrbProps) {
  const classes = [
    'assem-orb',
    `assem-orb--${state}`,
    `assem-orb--${size}`,
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div aria-label={`Nucleo visual de ASSEM: ${label}`} className={classes} data-state={state}>
      <div aria-hidden="true" className="assem-orb__stage">
        <span className="assem-orb__aura" />
        <span className="assem-orb__sweep assem-orb__sweep--slow" />
        <span className="assem-orb__sweep assem-orb__sweep--fast" />
        <span className="assem-orb__ring assem-orb__ring--outer" />
        <span className="assem-orb__ring assem-orb__ring--middle" />
        <span className="assem-orb__ring assem-orb__ring--inner" />
        <span className="assem-orb__ticks" />
        <span className="assem-orb__pulse assem-orb__pulse--one" />
        <span className="assem-orb__pulse assem-orb__pulse--two" />
        <span className="assem-orb__core">
          <span aria-label="ASSEM" className="assem-orb__brand">
            <span>A</span>
            <span>S</span>
            <span>S</span>
            <span>E</span>
            <span>M</span>
          </span>
          <span className="assem-orb__signal">{label}</span>
        </span>
      </div>
      {diagnostic && <div className="assem-orb__diagnostic">{diagnostic}</div>}
    </div>
  );
}
