/** @type {import('tailwindcss').Config} */

import defaultTheme from 'tailwindcss/defaultTheme'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
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
      },
      keyframes: {
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
