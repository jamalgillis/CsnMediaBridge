import type { ReactNode } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

export default function GlassCard({ children, className = '', padded = true }: GlassCardProps) {
  return (
    <div
      className={`
        rounded-card
        border border-surface-light-border bg-surface-light-card shadow-card-light shadow-glow-light
        dark:border-surface-border dark:bg-surface-card dark:shadow-card dark:shadow-glow
        ${padded ? 'p-6' : ''}
        ${className}
      `}
    >
      {children}
    </div>
  );
}
