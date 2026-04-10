/** @type {Record<string, Record<string, string>>} */
const colors = {
  primary: {
    50: '#ecfeff',
    100: '#cffafe',
    200: '#a5f3fc',
    300: '#67e8f9',
    400: '#22d3ee',
    500: '#06b6d4',
    600: '#0891b2',
    700: '#0e7490',
    800: '#155e75',
    900: '#164e63',
    950: '#083344',
  },
  secondary: {
    50: '#ecfdf5',
    100: '#d1fae5',
    200: '#a7f3d0',
    300: '#6ee7b7',
    400: '#34d399',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
    800: '#065f46',
    900: '#064e3b',
    950: '#022c22',
  },
  surface: {
    deep: '#0d0f11',
    card: '#1a1d21',
    elevated: '#22262b',
    border: 'rgba(255, 255, 255, 0.08)',
    glass: 'rgba(255, 255, 255, 0.03)',
  },
  'surface-light': {
    deep: '#f8fafc',
    card: '#ffffff',
    elevated: '#f1f5f9',
    border: 'rgba(0, 0, 0, 0.05)',
    glass: 'rgba(0, 0, 0, 0.02)',
  },
};

module.exports = colors;
