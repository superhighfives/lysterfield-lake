// A control's one-word label. Not drawn here: the custom cursor
// (components/cursor.tsx) shows it under its ring while the control's
// hovered. It's still the control's text for screen readers.
function Tooltip({ text }: { text: string }) {
  return (
    <span className="sr-only" data-cursor-label>
      {text}
    </span>
  )
}

export default Tooltip
