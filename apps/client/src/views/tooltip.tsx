function Tooltip({
  text,
  placement = 'above',
}: {
  text: string
  placement?: 'above' | 'below'
}) {
  const position =
    placement === 'above'
      ? 'bottom-full mb-1 left-1/2 -translate-x-1/2'
      : 'top-full mt-1 left-1/2 -translate-x-1/2'

  return (
    <div
      className={`group-hover:opacity-100 whitespace-nowrap text-yellow-900 font-mono uppercase tracking-widest text-[10px] leading-none transition opacity-0 bg-yellow-400 px-1.5 py-1 rounded-sm absolute z-50 pointer-events-none ${position}`}
    >
      {text}
    </div>
  )
}

export default Tooltip
