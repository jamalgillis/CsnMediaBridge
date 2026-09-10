import type { ReactNode } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

/** The standard CSN card: hairline rule around the panel surface, 8px radius. */
export default function GlassCard({ children, className = '', padded = true }: GlassCardProps) {
  return <div className={`csn-card ${padded ? 'p-5' : ''} ${className}`}>{children}</div>;
}
