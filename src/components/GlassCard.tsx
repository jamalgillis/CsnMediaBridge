import type { ReactNode } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

/** The standard Spool card: hairline border on the card surface, 13px radius. */
export default function GlassCard({ children, className = '', padded = true }: GlassCardProps) {
  return <div className={`spool-card ${padded ? 'p-5' : ''} ${className}`}>{children}</div>;
}
