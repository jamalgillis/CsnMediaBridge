const colors = require('./data/config/colors');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: colors.primary,
        secondary: colors.secondary,
        surface: colors.surface,
        'surface-light': colors['surface-light'],
      },
      fontFamily: {
        sans: ['Inter', 'Geist Sans', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        card: '1.5rem',
        widget: '1rem',
      },
      boxShadow: {
        glow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
        'glow-light': 'inset 0 0 0 1px rgba(0, 0, 0, 0.03)',
        card: '0 2px 24px rgba(0, 0, 0, 0.25)',
        'card-light': '0 2px 16px rgba(0, 0, 0, 0.06)',
      },
      backgroundImage: {
        'premium-glow': 'linear-gradient(135deg, #ccfbf1 0%, #2dd4bf 100%)',
      },
      maxWidth: {
        dashboard: '90rem',
      },
    },
  },
  plugins: [],
};
