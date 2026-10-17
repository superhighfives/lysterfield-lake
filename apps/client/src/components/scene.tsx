import {
	DeviceOrientationControls,
	OrbitControls,
	PerspectiveCamera,
	Scroll,
	ScrollControls,
} from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
	AmbientLight,
	MathUtils,
	Mesh,
	Vector3,
	MeshStandardMaterial,
	PerspectiveCamera as PerspectiveCameraType,
	SpotLight,
	Event as ThreeEvent,
} from "three";
import { useStore } from "../store";
import { getRotation } from "../utils";
import Choose from "../views/choose";
import Main from "../views/main";
import Fireflies from "./fireflies";
import WakePass from "./wake-pass";

// Half-angle of the choose screen's pointer-following light cone. With a
// full penumbra, brightness falls off smoothly from the centre to this edge.
const SPOT_ANGLE_CHOOSING = 0.85;
// Choose-screen light balance, per colour scheme. three.js's ambient light
// delivers intensity / PI to a white surface, so it takes ~PI to light the
// (untone-mapped, see polaroid.tsx) carousel frames to near-white; the spot
// pool on top then clips the highlighted cards to full white. Dark mode's
// charcoal frames need far less spot, or the pool reads as a glare.
const CHOOSING_LIGHT = {
	light: { ambient: 2.6, spot: 2.5 },
	dark: { ambient: 2.6, spot: 0.6 },
};
// The player's spotlight, per colour scheme. On the glossy charcoal frame
// in dark mode, the full-strength light made a hard white streak — it's
// meant to be a faint sheen as the polaroid tilts.
const PLAYER_SPOT = { light: 5, dark: 1.2 };

function Scene({ video }: { video: RefObject<HTMLVideoElement | null> }) {
	const camera = useRef<PerspectiveCameraType>(null);
	const { viewport } = useThree((state) => state);
	const { width: w, height: h } = viewport;
	// Pulled back from 1.5 to shrink the whole scene a little. Layout
	// positions are in viewport units (`h`), which grow with the distance,
	// so things keep their place on screen and only get smaller.
	const CAMERA_Z = 1.8;
	const isMobile = useStore((state) => state.isMobile);
	const isTouch = useStore((state) => state.isTouch);

	const dream = useStore((state) => state.dream);
	const setShowPlayhead = useStore((state) => state.setShowPlayhead);
	const initialRotation = useStore((state) => state.initialRotation);
	const resetting = useStore((state) => state.resetting);

	// These all used to be React state set every frame from useFrame,
	// re-rendering Scene (and everything under it, including Choose's whole
	// Slider) 60x/sec — see choose.tsx and main.tsx for the fuller writeup of
	// this pattern. `globalPointer` in particular used to mirror the store's
	// per-frame pointer value into local state purely so the dot mesh below
	// could read it reactively; it's set directly on the mesh ref instead now.
	const dotMesh = useRef<Mesh>(null);
	const ambient = useRef<AmbientLight>(null);
	const dotMaterial = useRef<MeshStandardMaterial>(null);

	const setInitialRotation = useStore((state) => state.setInitialRotation);
	const resetInitialRotation = useStore((state) => state.resetInitialRotation);
	const setResetInitialRotation = useStore(
		(state) => state.setResetInitialRotation,
	);
	useEffect(() => {
		setShowPlayhead(dream !== null && !resetting);
	}, [dream, resetting]);

	useFrame((state) => {
		const cameraRef = camera.current;

		if (isMobile || isTouch) {
			if (dotMaterial.current)
				dotMaterial.current.opacity = useStore.getState().polaroidVisible;
		}

		// The spotlight only lights the polaroid frames (the photos are
		// unlit), and mostly diffusely — a frame is brightest when it faces
		// the light. In the carousel's fan, right-hand cards face left, so a
		// light anywhere to the right lit the *left* half of the row
		// brightest, wherever the pointer was. On the choose screen the
		// light instead sits at the camera and aims at the point under the
		// pointer, with a soft-edged cone: brightness follows a pool of light
		// under the mouse rather than which way each card happens to face.
		// It eases back to the original fixed light (tuned for the player's
		// polaroid) once a dream is selected.
		const choosing = !dream;
		const target = spotlight.target.position;
		if (choosing) {
			spotTarget.set(
				(state.pointer.x * viewport.width) / 2,
				(state.pointer.y * viewport.height) / 2,
				0,
			);
			spotPosition.set(state.camera.position.x, state.camera.position.y, CAMERA_Z + 1);
		} else {
			spotTarget.set(0, 0, 0);
			spotPosition.set(5, 0, 30);
		}

		target.lerp(spotTarget, 0.08);
		spotlight.target.updateMatrixWorld();
		spotlight.position.lerp(spotPosition, 0.08);
		spotlight.angle = MathUtils.lerp(
			spotlight.angle,
			choosing ? SPOT_ANGLE_CHOOSING : Math.PI / 3,
			0.08,
		);
		spotlight.penumbra = MathUtils.lerp(spotlight.penumbra, choosing ? 1 : 0, 0.08);
		// Cards outside the pool used to drop to ambient-only, which read as
		// far too dark (the left half of the row with the pointer hard
		// right). On the choose screen the ambient fill comes up and the
		// spot comes down, so the pool still reads but the falloff is
		// gentle. The player keeps the original balance.
		const scheme = useStore.getState().colorScheme;
		const levels = CHOOSING_LIGHT[scheme];
		spotlight.intensity = MathUtils.lerp(
			spotlight.intensity,
			choosing ? levels.spot : PLAYER_SPOT[scheme],
			0.08,
		);
		if (ambient.current) {
			ambient.current.intensity = MathUtils.lerp(
				ambient.current.intensity,
				choosing ? levels.ambient : 0.5,
				0.08,
			);
		}

		const pointer = useStore.getState().globalPointer;
		if (dotMesh.current) {
			dotMesh.current.position.set(pointer.x - 1.0, pointer.y - 1.0, -0.5);
		}

		if (cameraRef && !isMobile && !isTouch) {
			// Halved on the choose screen (pan and dolly both): there, the
			// carousel's cards float toward the pointer individually (see
			// slider.tsx), and full camera parallax on top made the whole row
			// swing and zoom as one rigid object.
			const parallax = dream ? 1 : 0.5;
			cameraRef.position.x = MathUtils.lerp(
				cameraRef.position.x,
				(-state.pointer.x / 8) * parallax,
				0.05,
			);
			cameraRef.position.y = MathUtils.lerp(
				cameraRef.position.y,
				(-state.pointer.y / 8) * parallax,
				0.05,
			);

			cameraRef.position.z = MathUtils.lerp(
				cameraRef.position.z,
				CAMERA_Z - (state.pointer.y / 4) * parallax,
				0.01,
			);
		}
	});

	const fakeCamera = new PerspectiveCameraType();

	const [rotation, setRotation] = useState([0, 0, 0]);

	const onOrientationChange = (e?: ThreeEvent) => {
		if (resetInitialRotation) {
			const r = getRotation(e, [0, 0, 0]);
			setInitialRotation(r as [number, number, number]);
			setResetInitialRotation(false);
			setRotation(r as number[]);
		} else {
			const r = getRotation(e, initialRotation);
			setRotation(r as number[]);
		}
	};

	// Position and target are driven every frame (see useFrame above), so
	// they're set here once rather than as JSX props a re-render could
	// reapply mid-ease.
	const spotlight = useMemo(() => {
		const light = new SpotLight("#fff");
		light.position.set(5, 0, 30);
		light.intensity = 5;
		return light;
	}, []);
	const spotTarget = useMemo(() => new Vector3(), []);
	const spotPosition = useMemo(() => new Vector3(5, 0, 30), []);

	return (
		<>
			<PerspectiveCamera
				ref={camera}
				makeDefault
				position={[0, 0, CAMERA_Z]}
				fov={50}
				zoom={w >= 1 ? 1 : w}
			/>
			{isMobile ? (
				<DeviceOrientationControls
					camera={fakeCamera}
					onChange={onOrientationChange}
				/>
			) : null}
			{/* Pan off too: nothing uses it, and a right- or modifier-drag
			    (or a two-finger drag) panned the camera's target, which
			    nothing ever reset — the scene stayed skewed. */}
			{!isMobile && !isTouch ? (
				<OrbitControls
					enableRotate={false}
					enableZoom={false}
					enablePan={false}
				/>
			) : null}
			<WakePass />
			<ambientLight ref={ambient} intensity={0.5} />
			<group>
				{/* decay={0} — three.js dropped the legacy (non-physically-correct)
            lighting mode this session's three/fiber bump pulled in, so this
            light's intensity is now read as physical candela with real
            inverse-square falloff by default. At 30 units away that made it
            contribute almost nothing, leaving the polaroid frames lit by
            flat ambient only (gray/washed out) instead of this light's
            highlights. decay={0} restores the old flat, distance-independent
            falloff this scene was tuned for; intensity bumped to 2 on top of
            that to bring the frames back up to a proper bright white. */}
				<primitive
					object={spotlight}
					decay={0}
					castShadow
					shadow-bias={-0.01}
					shadow-mapSize-width={1024}
					shadow-mapSize-height={1024}
				/>
				<primitive object={spotlight.target} />
			</group>

			<ScrollControls pages={2.7} damping={0.1}>
				{/* Inside ScrollControls (for its scroll offset) but outside
				    <Scroll>, so the swarm isn't carried with the content. */}
				<Fireflies />
				<Scroll>
					<Choose position={[0, 0, 0]} />
					<Main video={video} position={[0, -h * 1.6, 0]} tilt={rotation} />
				</Scroll>
			</ScrollControls>

			{isMobile || isTouch ? (
				<>
					<mesh
						ref={dotMesh}
						visible={dream !== null && !resetting}
						scale={0.025}
					>
						<circleGeometry args={[1, 16]} />
						<meshStandardMaterial ref={dotMaterial} color="#666" transparent />
					</mesh>
				</>
			) : null}
		</>
	);
}

export default Scene;
