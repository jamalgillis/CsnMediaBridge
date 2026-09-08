const colors = require('./data/config/colors');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: colors.primary,
        secondary: colors.secondary,
        surface: colors.surface,
        ink: colors.ink,
        state: colors.state,
        platform: colors.platform,
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Spool's type scale is on half-pixel steps; these are the exact ramp.
        overline: ['10.5px', { lineHeight: '1.4', letterSpacing: '0.09em', fontWeight: '700' }],
        micro: ['10px', { lineHeight: '1.4' }],
        meta: ['10.5px', { lineHeight: '1.4' }],
        caption: ['11.5px', { lineHeight: '1.45' }],
        count: ['11px', { lineHeight: '1.4' }],
        control: ['13px', { lineHeight: '1.4' }],
        body: ['13.5px', { lineHeight: '1.5' }],
        row: ['14px', { lineHeight: '1.45' }],
        section: ['18px', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '700' }],
        page: ['23px', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '700' }],
        display: ['34px', { lineHeight: '1.08', letterSpacing: '-0.03em', fontWeight: '800' }],
      },
      borderRadius: {
        chip: '7px',
        badge: '6px',
        control: '10px',
        card: '13px',
        bubble: '15px',
        panel: '12px',
      },
      spacing: {
        rail: '248px',
        topbar: '60px',
        control: '38px',
      },
      height: {
        control: '38px',
        hit: '44px',
        topbar: '60px',
      },
      boxShadow: {
        pop: '0 18px 50px rgba(0, 0, 0, 0.55)',
        toast: '0 14px 40px rgba(0, 0, 0, 0.5)',
        ring: '0 0 0 2px rgba(14, 121, 178, 0.45)',
      },
      backgroundImage: {
        mark: 'linear-gradient(135deg, #0e79b2, #748b75)',
        'teal-tint': 'linear-gradient(135deg, #7fc4e3, #3f9ecb)',
      },
      keyframes: {
        spoolin: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        spoolpulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.35' },
        },
      },
      animation: {
        spoolin: 'spoolin .25s ease both',
        'spoolin-fast': 'spoolin .15s ease both',
        spoolpulse: 'spoolpulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
