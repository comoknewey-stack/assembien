import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

export type SurfaceVariant = 'default' | 'soft' | 'hero' | 'active' | 'warning' | 'error';
export type SurfaceRadius = 'sm' | 'md' | 'lg' | 'hero';
export type SurfaceGlow = 'none' | 'cyan' | 'amber' | 'red' | 'neutral';

type SurfaceProps<T extends ElementType> = {
  as?: T;
  children?: ReactNode;
  className?: string;
  glow?: SurfaceGlow;
  radius?: SurfaceRadius;
  variant?: SurfaceVariant;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'className' | 'children'>;

export function Surface<T extends ElementType = 'div'>({
  as,
  children,
  className,
  glow = 'none',
  radius = 'md',
  variant = 'default',
  ...props
}: SurfaceProps<T>) {
  const Component = as ?? 'div';
  const classes = [
    'surface',
    `surface--${variant}`,
    `squircle-${radius}`,
    glow !== 'none' ? `glow-${glow}` : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Component className={classes} {...props}>
      {children}
    </Component>
  );
}
