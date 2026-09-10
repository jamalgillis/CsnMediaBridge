/**
 * CSN v2 design-system tokens.
 *
 * Source of truth: the sports site's `apps/web/app/globals.css` `@theme` block
 * (`Websites/csn`). The names and hex values here are copied from it verbatim so
 * a class written in this app means the same thing it means on the site:
 * `ink` is the black canvas, `paper` is the type on top of it, `accent` is the
 * one brand red. Keep the two in step.
 *
 * The one addition is `state` — the public site is monochrome plus red and has
 * no vocabulary for queue state, so the ops hues come from the CSN admin theme
 * (`apps/admin/app/globals.css`: --good / --warn / --hot).
 *
 * @type {Record<string, Record<string, string> | string>}
 */
const colors = {
  // Surfaces, darkest first. `ink` is the app canvas and all fixed chrome.
  ink: {
    DEFAULT: '#050505', // canvas, sidebar, top bar
    panel: '#0b0b0b', // cards and panels
    raised: '#0e0e0e', // recessed wells, list rows
    tile: '#141414', // fields, thumbnails, media surfaces
    chip: '#1c1c1c', // chips, popovers, avatars
  },

  // Type, brightest first. `paper` is the default foreground.
  paper: '#fbfef9',
  body: '#d6d6d6',
  soft: '#c2c2c2',
  mid: '#b5b5b5',
  quiet: '#9a9a9a',
  muted: '#8c8c8c',
  dim: '#6b6b6b',
  faint: '#5a5a5a',
  ghost: '#4a4a4a',

  // The single brand color. Live dots, active nav, primary actions, focus.
  accent: {
    DEFAULT: '#ee1518',
    hi: '#ff3d42', // hover / hot
  },

  // Hairlines. Mirrors --rule / --rule-soft / --rule-strong on the site.
  rule: {
    DEFAULT: 'rgba(255, 255, 255, 0.09)',
    soft: 'rgba(255, 255, 255, 0.07)',
    strong: 'rgba(255, 255, 255, 0.16)',
  },

  // Operational status. Color carries meaning: green is done, amber is working,
  // red is failed. Anything "live" uses `accent`, as it does on the site.
  state: {
    ok: '#2dd4a4',
    warn: '#ffb84d',
    danger: '#ff4d6d',
  },

  // Publish destinations. Reserved for platform chips/glyphs — never UI chrome.
  platform: {
    tiktok: '#fe2c55',
    reels: '#e1458f',
    shorts: '#ff5c52',
    igfeed: '#b14fe0',
    facebook: '#2d7ff9',
    youtube: '#ff3b30',
  },
};

module.exports = colors;
