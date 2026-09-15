/**
 * The window's own title row: a 38px band of chrome with the app name centred
 * in the condensed label voice. The OS frame is hidden (see `main.ts`), so the
 * whole row is the drag region and the platform's real window controls are
 * inset into it — the traffic lights on the left on macOS, the caption buttons
 * on the right on Windows. The 78px reserve on the trailing edge keeps the
 * centred title from colliding with those buttons.
 */
export default function TitleBar() {
  return (
    <div className="drag flex h-titlebar flex-none items-center gap-3 border-b border-rule bg-ink-panel px-3.5">
      <div className="w-[78px] flex-none" />
      <div className="min-w-0 flex-1 truncate text-center font-condensed text-[12px] font-bold uppercase tracking-[.12em] text-muted">
        Media Bridge
      </div>
      <div className="w-[78px] flex-none" />
    </div>
  );
}
