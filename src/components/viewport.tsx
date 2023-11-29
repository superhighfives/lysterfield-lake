import { ComponentPropsWithoutRef, ReactNode } from 'react'

function Viewport({
  children,
  className,
  ...props
}: {
  children: ReactNode
  className?: string
  props?: ComponentPropsWithoutRef<'div'>
}) {
  return (
    <div
      className={`h-screen flex flex-col transition-all duration-1000 ${className}`}
      {...props}
    >
      {children}
    </div>
  )
}

export default Viewport
