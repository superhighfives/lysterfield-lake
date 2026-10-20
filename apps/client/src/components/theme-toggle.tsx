import { KeyboardEvent, useEffect, useRef } from 'react'
import { Desktop, Moon, Sun } from '@phosphor-icons/react'
import { useStore } from '../store'
import {
  ThemePreference,
  applyColorScheme,
  darkQuery,
  resolveColorScheme,
  writeThemePreference,
} from '../utils/theme'
import Tooltip from '../views/tooltip'

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] =
  [
    { value: 'system', label: 'System', Icon: Desktop },
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
  ]

function ThemeToggle() {
  const themePreference = useStore((state) => state.themePreference)
  const setThemePreference = useStore((state) => state.setThemePreference)
  const setColorScheme = useStore((state) => state.setColorScheme)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  // Keeps the `.dark` class on <html> (Tailwind's `dark:` variants) and the
  // store's resolved `colorScheme` (the 3D scene's shader uniforms) in step
  // with the preference — and, while following the system, with the OS
  // setting changing underneath us.
  useEffect(() => {
    writeThemePreference(themePreference)

    const update = () => {
      const scheme = resolveColorScheme(themePreference)
      applyColorScheme(scheme)
      setColorScheme(scheme)
    }

    update()

    if (themePreference !== 'system') return
    const query = darkQuery()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [themePreference])

  // Standard radio-group keyboard behaviour: the group is a single tab
  // stop, and the arrow keys move the selection (and focus) between options.
  const handleKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0
    if (!step) return
    event.preventDefault()
    const current = OPTIONS.findIndex((o) => o.value === themePreference)
    const next = (current + step + OPTIONS.length) % OPTIONS.length
    setThemePreference(OPTIONS[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour scheme"
      className="flex items-center gap-0.5 p-0.5 rounded"
    >
      {OPTIONS.map(({ value, label, Icon }, i) => {
        const checked = value === themePreference
        return (
          <div key={value} className="group relative flex">
            <button
              ref={(el) => {
                buttons.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              tabIndex={checked ? 0 : -1}
              onClick={() => setThemePreference(value)}
              onKeyDown={handleKeyDown}
              className={`p-1.5 rounded transition-colors ${
                checked
                  ? 'bg-yellow-400 text-yellow-800 shadow-sm'
                  : 'hover:bg-yellow-400/30'
              }`}
            >
              <Icon />
            </button>
            <Tooltip text={label} />
          </div>
        )
      })}
    </div>
  )
}

export default ThemeToggle
