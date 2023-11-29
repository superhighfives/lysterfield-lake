function Tooltip({ text }: { text: string }) {
  return (
    <div className="group-hover:opacity-100 whitespace-nowrap text-yellow-800 font-sans transition opacity-0 bg-yellow-400 text-sm px-2 py-1 rounded absolute -translate-y-[calc(50%_+_22px)] top-0 left-0 pointer-events-none">
      {text}
    </div>
  )
}

export default Tooltip
