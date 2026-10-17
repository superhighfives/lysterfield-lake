import type { ComponentType } from 'react'
import type { CarouselStyle } from '../../store'
import type { CarouselProps } from './shared'
import Hand from './hand'
import Lake from './lake'
import Scatter from './scatter'
import Stack from './stack'

/** The experimental layouts; 'fan' (components/slider.tsx) isn't here, as
 *  it's laid out by choose.tsx itself. */
export const CAROUSELS: Record<
  Exclude<CarouselStyle, 'fan'>,
  ComponentType<CarouselProps>
> = {
  stack: Stack,
  scatter: Scatter,
  lake: Lake,
  hand: Hand,
}
