// A small turning ring: the loading pile's, before its first card lands
// (components/loading.tsx), and the page's until the app is ready
// (components/fallback.tsx). index.html draws the same ring, with the same
// classes, until the app's code has loaded.
function Spinner() {
  return (
    <div className="w-7 h-7 rounded-full border-2 border-stone-300 border-t-stone-500 dark:border-stone-700 dark:border-t-stone-400 motion-safe:animate-spin" />
  )
}

export default Spinner
