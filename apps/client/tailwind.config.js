/** @type {import('tailwindcss').Config} */

import defaultTheme from 'tailwindcss/defaultTheme'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Toggled via a `.dark` class on <html> (see src/utils/theme.ts) rather
  // than the `media` default, so the in-page toggle can override the OS.
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', ...defaultTheme.fontFamily.sans],
        serif: ['"Redaction 35"', ...defaultTheme.fontFamily.serif],
        mono: ['"Space Mono"', ...defaultTheme.fontFamily.mono],
      },
      colors: {
        background: '#f5f5f4',
        yellow: {
          400: '#f8cd0d',
        },
      },
      animation: {
        background: 'background 30s linear infinite',
        'fade-in': 'fade-in 0.3s linear forwards',
        // A loading polaroid falling onto the pile (components/loading.tsx),
        // overshooting a touch as it lands.
        'card-drop': 'card-drop 0.55s cubic-bezier(0.3, 1.35, 0.5, 1) both',
        // And falling away once the scene's in, gathering speed — the pile
        // keeping its shape, as one.
        'card-leave': 'card-leave 0.6s cubic-bezier(0.5, 0, 0.75, 0.2) both',
      },
      keyframes: {
        'card-drop': {
          '0%': {
            transform:
              'translate(var(--x), calc(var(--y) - 55vh)) rotate(calc(var(--r) + 28deg)) scale(1.12)',
            opacity: '0',
          },
          '40%': { opacity: '1' },
          '100%': {
            transform: 'translate(var(--x), var(--y)) rotate(var(--r))',
            opacity: '1',
          },
        },
        'card-leave': {
          '0%': {
            transform: 'translate(var(--x), var(--y)) rotate(var(--r))',
            opacity: '1',
          },
          '70%': { opacity: '1' },
          '100%': {
            transform:
              'translate(var(--x), calc(var(--y) + 65vh)) rotate(calc(var(--r) - 10deg)) scale(0.94)',
            opacity: '0',
          },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        background: {
          '0%': { backgroundPositionX: '0' },
          '100%': { backgroundPositionX: 'calc(100% - 100vw)' },
        },
      },
      screens: {
        xs: '400px',
      },
    },
  },
  plugins: [],
}
