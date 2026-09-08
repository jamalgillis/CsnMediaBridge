/**
 * Spool design system tokens (Teal & Taupe variant).
 *
 * Source of truth: `Spool - Design System - Teal.dc.html` from the design handoff.
 * The app prototype file has the superseded electric-blue/pink palette baked into
 * its inline styles — those hex values are deliberately NOT mirrored here.
 *
 * @type {Record<string, Record<string, string>>}
 */
const colors = {
  // Teal Blue — the single action color. Primary buttons, links, active nav/tabs.
  primary: {
    50: '#eaf6fc',
    100: '#cceaf6',
    200: '#7fc4e3', // "Teal Tint" — active label text
    300: '#5fb9e0',
    400: '#3f9ecb', // mid tint — scheduled state, mono numerics
    500: '#0e79b2', // base — buttons, active fills
    600: '#0c6699', // hover
    700: '#094d76',
    800: '#073a5a',
    900: '#052a42',
    950: '#031b2b',
  },
  // Sage — reserved for clip / unread / notify. Never used as general chrome.
  secondary: {
    50: '#f2f5f1',
    100: '#e2e9e1',
    200: '#c5d3c3',
    300: '#a6bca7', // lighter tint — text on sage wash
    400: '#8ba28c',
    500: '#748b75', // base — unread badges, clip accents
    600: '#5d715e',
    700: '#495a4a',
    800: '#364336',
    900: '#242d24',
    950: '#141a14',
  },
  surface: {
    canvas: '#0a0b0e', // app background
    rail: '#0c0e12', // sidebar & panel rails
    card: '#15171d', // cards, message bubbles
    field: '#14161b', // inputs, controls, chips
    well: '#121419', // list rows, recessed wells
    elevated: '#1a1d24', // dropdowns, modals, popovers
    scrim: '#0e1014', // thumbnail backing, modal inputs
    raised: 'rgba(255, 255, 255, 0.05)', // hover state
    hairline: 'rgba(255, 255, 255, 0.07)', // borders & dividers
    'hairline-strong': 'rgba(255, 255, 255, 0.12)',
  },
  ink: {
    DEFAULT: '#edeef1', // titles, body, values
    strong: '#cdd2da', // secondary headings, control labels
    muted: '#9ba2ae', // sublines, descriptions
    faint: '#6b7484', // captions, labels
    dim: '#5c6573', // counts, timecodes, hints
  },
  // Semantic state colors. Color carries meaning: green only posted, amber only
  // processing, teal-mid only queued.
  state: {
    posted: '#5ee6ad',
    scheduled: '#3f9ecb',
    processing: '#fbbf24',
    danger: '#f87171',
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
