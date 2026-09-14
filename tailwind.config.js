const colors = require('./data/config/colors');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: colors.ink,
        paper: colors.paper,
        body: colors.body,
        soft: colors.soft,
        mid: colors.mid,
        quiet: colors.quiet,
        muted: colors.muted,
        dim: colors.dim,
        faint: colors.faint,
        ghost: colors.ghost,
        accent: colors.accent,
        rule: colors.rule,
        state: colors.state,
        platform: colors.platform,
      },
      fontFamily: {
        // Anton for display numerals and screen titles, Barlow Condensed for the
        // uppercase label voice, Barlow for everything else — as on the site.
        display: ['Anton', 'Impact', 'sans-serif'],
        sans: ['Barlow', 'system-ui', 'sans-serif'],
        condensed: ['Barlow Condensed', 'Barlow', 'sans-serif'],
        // CSN sets numerics in the body face with tabular figures rather than a
        // mono face; `.font-mono` also switches on tnum (see index.css).
        mono: ['Barlow', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // Semantic ramp. The label sizes ride the condensed face; body sizes are
        // Barlow, which runs a touch smaller on the eye than a grotesk at the
        // same px, so the ramp sits slightly above the old one.
        overline: ['11px', { lineHeight: '1.4', letterSpacing: '0.12em', fontWeight: '700' }],
        micro: ['10px', { lineHeight: '1.4', letterSpacing: '0.06em' }],
        meta: ['11px', { lineHeight: '1.4' }],
        caption: ['12px', { lineHeight: '1.45' }],
        count: ['11px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        control: ['13px', { lineHeight: '1.4' }],
        copy: ['14px', { lineHeight: '1.5' }],
        row: ['15px', { lineHeight: '1.45' }],
        // Section and page titles run in Anton; the tracking is its own.
        section: ['20px', { lineHeight: '1.15', letterSpacing: '0.01em' }],
        page: ['30px', { lineHeight: '1.05', letterSpacing: '0.01em' }],
        display: ['40px', { lineHeight: '1', letterSpacing: '0.01em' }],
      },
      borderRadius: {
        // CSN v2 is a squared-off system: 2px on controls, chips, badges and
        // toggles; 3px on cards and panels. Nothing is rounder than 3px except
        // the DS's own capsule chips and buttons, which stay `rounded-full`.
        chip: '2px',
        badge: '2px',
        control: '2px',
        card: '3px',
        bubble: '3px',
        panel: '3px',
      },
      spacing: {
        // Bridge runs a narrower rail than the web app's 248px, and its window
        // chrome is a 38px title bar rather than a 64px site header.
        rail: '206px',
        titlebar: '38px',
        control: '38px',
      },
      height: {
        control: '38px',
        chip: '34px',
        inline: '30px',
        hit: '44px',
        titlebar: '38px',
      },
      boxShadow: {
        pop: '0 18px 50px rgba(0, 0, 0, 0.6)',
        toast: '0 14px 40px rgba(0, 0, 0, 0.55)',
        ring: '0 0 0 2px rgba(238, 21, 24, 0.45)',
        // The site marks the active nav item with an inset accent underline.
        nav: 'inset 0 -3px 0 0 #ee1518',
        tab: 'inset 0 -2px 0 0 #ee1518',
        // Live status chips sit on ink inside a 1px inset accent ring rather
        // than on a tinted fill — see design.md §2, "Status chip".
        live: 'inset 0 0 0 1px #ee1518',
        rule: 'inset 0 0 0 1px rgba(255, 255, 255, 0.16)',
      },
      backgroundImage: {
        mark: 'linear-gradient(135deg, #ee1518, #7a0a0c)',
      },
      keyframes: {
        csnfade: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'none' },
        },
        csnpulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.25' },
        },
      },
      animation: {
        csnfade: 'csnfade .45s ease both',
        'csnfade-fast': 'csnfade .15s ease both',
        csnpulse: 'csnpulse 1.4s infinite',
      },
    },
  },
  plugins: [],
};
