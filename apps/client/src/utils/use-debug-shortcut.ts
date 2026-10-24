import { useEffect } from 'react'
import { useStore } from '../store'

// Shift+D, anywhere but a text field, toggles debug mode. Apart from the
// panel (components/debug-overlay.tsx), which loads only once debug mode is
// on, so the shortcut doesn't bring three.js along with the title.
export function useDebugShortcut() {
  const setDebug = useStore((state) => state.setDebug)
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.key.toLowerCase() !== 'd') return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable]')) return
      setDebug(!useStore.getState().debug)
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [setDebug])
}
