import type { ReactNode } from 'react'
import ThemeToggle from '../../components/theme-toggle.tsx'

// The frame round the public polaroid pages (/polaroids, /polaroids/add, /p/<id>): the way back to the song, the
// gallery and adding one, over the app's own background.

export const PRIMARY = 'inline-flex items-center rounded-full bg-yellow-400 px-4 py-1.5 text-sm font-medium text-stone-900 transition-colors hover:bg-black hover:text-white disabled:pointer-events-none disabled:opacity-40'
export const SECONDARY = 'inline-flex items-center rounded-full border border-stone-300 px-4 py-1.5 text-sm transition-colors hover:bg-yellow-200 hover:text-yellow-900 dark:border-stone-700 dark:hover:bg-yellow-400/20 dark:hover:text-yellow-300 disabled:pointer-events-none disabled:opacity-40'

export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
      <a href="/" className="font-serif text-xl italic text-stone-900 hover:text-yellow-700 dark:text-stone-100 dark:hover:text-yellow-400">
        Lysterfield Lake
      </a>
      <a href="/polaroids" className="text-sm text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100">
        Polaroids
      </a>
      <div className="ml-auto flex items-center gap-3">
        {children}
        <ThemeToggle />
      </div>
    </header>
  )
}

/** A page that scrolls, with its content in a column. */
export function Page({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-y-auto font-sans text-stone-900 dark:text-stone-100 [color-scheme:light] dark:[color-scheme:dark] [touch-action:auto]">
      <Header>{header}</Header>
      <main className="mx-auto max-w-xl px-4 pb-16 pt-8 sm:px-6">{children}</main>
    </div>
  )
}
