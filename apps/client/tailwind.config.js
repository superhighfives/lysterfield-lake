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
        // A loading polaroid falling onto the pile from above the window
        // (components/loading.tsx), overshooting a touch as it lands.
        'card-drop': 'card-drop 0.55s cubic-bezier(0.3, 1.35, 0.5, 1) both',
        // A loading polaroid's photo developing: milky and pale, then the
        // tones, then the colour.
        develop: 'develop 1.6s ease-out both',
        // And falling away off the bottom once the scene's in: slowly at
        // first, then faster as it goes.
        'card-leave': 'card-leave 1s cubic-bezier(0.32, 0, 0.67, 0) both',
      },
      keyframes: {
        'card-drop': {
          '0%': {
            transform:
              'translate(var(--x), calc(var(--y) - 75vh)) rotate(calc(var(--r) + 28deg)) scale(1.12)',
          },
          '100%': {
            transform: 'translate(var(--x), var(--y)) rotate(var(--r))',
          },
        },
        develop: {
          '0%': {
            opacity: '0',
            filter: 'brightness(1.7) contrast(0.5) saturate(0) blur(2px)',
          },
          '45%': {
            opacity: '1',
            filter: 'brightness(1.25) contrast(0.8) saturate(0.2) blur(0.5px)',
          },
          '100%': { opacity: '1', filter: 'none' },
        },
        'card-leave': {
          '0%': {
            transform: 'translate(var(--x), var(--y)) rotate(var(--r))',
          },
          '100%': {
            transform:
              'translate(var(--x), calc(var(--y) + 85vh)) rotate(calc(var(--r) - 10deg)) scale(0.94)',
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
