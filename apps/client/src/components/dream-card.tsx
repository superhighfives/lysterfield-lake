/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react'
import { ThreeEvent, useThree } from '@react-three/fiber'
import { Text, useCursor, useTexture } from '@react-three/drei'
import { a, animated, config, useSpring } from '@react-spring/three'
import { Euler, Texture } from 'three'
import Polaroid from '../models/polaroid'
import { PolaroidMaterial } from '../materials/polaroid-material'
import { useStore } from '../store'
import type { Dream } from '../utils/types'

// One dream's card on the choose screen: its polaroid, with the dream's
// hero image, and its title and prompt beneath. It lifts and tilts toward
// the viewer on hover. The cards of the choose screen's stack
// (components/carousels/stack.tsx).

const PolaroidShaderWrapper = a(({ ...props }) => (
  <polaroidMaterial {...props} />
))

export const CARD_SCALE = 0.1
const CARD_SCALE_HOVER = 0.12

function DreamCard({
  dream,
  onSelect,
  onHoverChange,
  tilt = true,
  showText = true,
  interactive = true,
  saturation = 1,
  photo,
}: {
  dream: Dream
  onSelect: (event: ThreeEvent<MouseEvent>) => void
  onHoverChange?: (hover: boolean) => void
  /** Tip back toward the viewer on hover (off where a layout turns it). */
  tilt?: boolean
  showText?: boolean
  /** Off for a card that shouldn't react to hover or clicks (a stacked
   *  card that isn't on top). */
  interactive?: boolean
  /** 1 = full colour, 0 = grayscale; eases between. */
  saturation?: number
  /** Shown in place of the dream's still (its loop, on the stack's top
   *  card). */
  photo?: Texture
}) {
  const dark = useStore((state) => state.colorScheme === 'dark')
  const textureImage = useTexture(`/assets/${dream.id}/hero.jpg`)
  const [hover, setHover] = useState(false)
  useCursor(hover)

  // Size only changes on a real resize, which useThree's selector already
  // limits re-renders to.
  const { width: canvasWidth, height: canvasHeight } = useThree(
    (state) => state.size
  )
  const size = [canvasWidth, canvasHeight]
  const aspect =
    canvasWidth > canvasHeight
      ? [1, canvasWidth / canvasHeight]
      : [canvasHeight / canvasWidth, 1]

  const { uHover: hoverAmount } = useSpring({
    uHover: hover ? 1.0 : 0.0,
    config: { ...config.molasses, precision: 0.0000001 },
  })
  const { uSaturation: saturationAmount } = useSpring({
    uSaturation: saturation,
    config: { ...config.slow, precision: 0.0001 },
  })
  const { scale: scaleAmount } = useSpring({
    scale: hover ? CARD_SCALE_HOVER : CARD_SCALE,
    config: { ...config.molasses, precision: 0.0000001 },
  })
  const { rotation: rotationAmount } = useSpring({
    rotation: hover && tilt ? [-0.25, 0, 0] : [0, 0, 0],
    config: { ...config.molasses, precision: 0.0000001 },
  })

  const setHovered = (value: boolean) => {
    if (value && !interactive) return
    setHover(value)
    onHoverChange?.(value)
  }

  // Losing interactivity mid-hover (it's no longer on top) lets go of it.
  useEffect(() => {
    if (!interactive) setHover(false)
  }, [interactive])

  return (
    <animated.group
      rotation={rotationAmount as unknown as Euler}
      scale={scaleAmount}
    >
      <Polaroid
        layered
        onPointerOver={(e) => {
          e.stopPropagation()
          setHovered(true)
        }}
        onPointerOut={(e) => {
          e.stopPropagation()
          setHovered(false)
        }}
        onClick={(e) => interactive && onSelect(e as any)}
        passthroughMaterial={
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          //@ts-ignore: https://github.com/pmndrs/react-spring/issues/1515 */}
          <PolaroidShaderWrapper
            key={PolaroidMaterial.key}
            uTexture={photo ?? textureImage}
            uSize={size}
            uAspect={aspect}
            uHover={hoverAmount}
            uSaturation={saturationAmount}
          />
        }
      />
      {showText ? (
        <group position={[-1.55, -1.75, 0.1]}>
          <Text
            scale={0.25}
            font="/fonts/redaction/Redaction_35-Italic.ttf"
            color={dark ? 'white' : 'black'}
            fillOpacity={0.8}
            anchorX="left"
            anchorY="middle"
          >
            {dream.title}
          </Text>
          <Text
            scale={0.115}
            position={[0, -0.25, 0]}
            font="/fonts/space-mono/SpaceMono-Regular.ttf"
            color={dark ? '#78716c' : '#bbb'}
            anchorX="left"
            anchorY="middle"
          >
            {`"${dream.prompt}"`}
          </Text>
        </group>
      ) : null}
    </animated.group>
  )
}

export default DreamCard
