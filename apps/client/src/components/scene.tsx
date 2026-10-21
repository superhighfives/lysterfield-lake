import {
	PerformanceMonitor,
	DeviceOrientationControls,
	OrbitControls,
	PerspectiveCamera,
	Scroll,
	ScrollControls,
} from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { RefObject, useEffect, useMemo, useRef } from "react";
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
import DebugProbe from "./debug-probe";

// Half-angle of the choose screen's pointer-following light cone. With a
// full penumbra, brightness falls off smoothly from the centre to this edge.
const SPOT_ANGLE_CHOOSING = 0.85;
// Choose-screen light balance, per colour scheme. three.js's ambient light
// delivers intensity / PI to a white surface, so it takes ~PI to light the
// (untone-mapped, see polaroid.tsx) carousel frames to near-white; the spot
// pool on top then clips the highlighted cards to full white. Dark mode's
// charcoal frames need far less spot, or the pool reads as a glare.
// How far below its scroll page the player sits, as a share of the viewport
// height: enough to centre the polaroid on screen (it sits further back
// than z = 0, so it moves less than this on screen), rather than riding
// high above the controls.
const PLAYER_DROP = 0.1;
// The range the performance monitor steps the pixel ratio through (in
// quarters); the cap (store's dprCap) still applies on top.
const DPR_FLOOR = 1;
// Below PERF_LOW_FPS the monitor steps the pixel ratio down; above
// PERF_HIGH_FPS, back up.
const PERF_LOW_FPS = 45;
const PERF_HIGH_FPS = 55;

/** The monitor's factor (0-1) as a pixel ratio, in quarters, across what
 *  can actually change: from the floor up to the device's ratio or the
 *  cap, whichever's lower — so every step it takes does something. */
function dprForFactor(factor: number) {
	const cap = useStore.getState().dprCap ?? DPR_CEILING;
	const ceiling = Math.max(
		DPR_FLOOR,
		Math.min(cap, window.devicePixelRatio || 1),
	);
	return Math.round((DPR_FLOOR + factor * (ceiling - DPR_FLOOR)) * 4) / 4;
}

const DPR_CEILING = 2;
const CHOOSING_LIGHT = {
	light: { ambient: 2.6, spot: 2.5 },
	dark: { ambient: 2.6, spot: 0.6 },
};
// The player's spotlight, per colour scheme. On the glossy charcoal frame
// in dark mode, the full-strength light made a hard white streak — it's
// meant to be a faint sheen as the polaroid tilts.
const PLAYER_SPOT = { light: 5, dark: 1.2 };
// Fitting the player into short windows. Left alone, the polaroid spans
// PLAYER_TOP to PLAYER_BOTTOM of the window's height (its lyrics running
// on below it), centred, and on a short window the controls at the
// bottom cover the lyrics. So the view lifts to clear them — and, if
// lifting alone isn't enough, zooms out a little — keeping it under the
// header (PLAYER_HEADER px). The controls take PLAYER_CONTROLS px (two
// rows, PLAYER_CONTROLS_STACKED, below the xs breakpoint), plus a gap.
// PLAYER_FIT_EASE: how quickly (per frame) it settles.
const PLAYER_TOP = 0.17;
const PLAYER_BOTTOM = 0.92;
const PLAYER_HEADER = 64;
const PLAYER_CONTROLS = 40 + 34 + 16;
const PLAYER_CONTROLS_STACKED = 40 + 104 + 16;
const PLAYER_FIT_EASE = 0.1;
const STACKED_QUERY = "(max-width: 399px)";

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
	const wakeEnabled = useStore((state) => state.wakeEnabled);
	const debug = useStore((state) => state.debug);
	const setDprAuto = useStore((state) => state.setDprAuto);
	// The monitor starts at the top (factor 1) and only reports changes, so
	// the store starts there with it — or a remount (a hot reload, say)
	// leaves a stepped-down ratio that the monitor, already at the top,
	// never raises again.
	useEffect(() => setDprAuto(dprForFactor(1)), [setDprAuto]);
	// Mounted once everything it needs has loaded: the loading pile clears
	// away (components/loading.tsx).
	useEffect(() => useStore.getState().setSceneLoaded(true), []);

	// These all used to be React state set every frame from useFrame,
	// re-rendering Scene (and everything under it, including Choose's whole
	// stack) 60x/sec — see choose.tsx and main.tsx for the fuller writeup of
	// this pattern. `globalPointer` in particular used to mirror the store's
	// per-frame pointer value into local state purely so the dot mesh below
	// could read it reactively; it's set directly on the mesh ref instead now.
	const dotMesh = useRef<Mesh>(null);
	const ambient = useRef<AmbientLight>(null);
	const dotMaterial = useRef<MeshStandardMaterial>(null);

	// The player's fit (see PLAYER_TOP): how far the view's lifted (px)
	// and how far it's zoomed out (1 = not at all), eased.
	const fit = useRef({ lift: 0, scale: 1 });

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

		// Narrow windows zoom out to fit the width; short ones fit the
		// player between the header and the controls.
		if (cameraRef) {
			const base = w >= 1 ? 1 : w;
			let lift = 0;
			let scale = 1;
			if (dream && !resetting) {
				const { width, height } = state.size;
				const controls = window.matchMedia(STACKED_QUERY).matches
					? PLAYER_CONTROLS_STACKED
					: PLAYER_CONTROLS;
				const room = height - PLAYER_HEADER - controls;
				const span = (PLAYER_BOTTOM - PLAYER_TOP) * base * height;
				scale = Math.min(1, room / span);
				const top = height * (0.5 - (0.5 - PLAYER_TOP) * base * scale);
				const bottom =
					height * (0.5 + (PLAYER_BOTTOM - 0.5) * base * scale);
				lift = Math.max(
					0,
					Math.min(bottom - (height - controls), top - PLAYER_HEADER),
				);
				if (width === 0) lift = 0;
			}

			const current = fit.current;
			current.lift = MathUtils.lerp(current.lift, lift, PLAYER_FIT_EASE);
			current.scale = MathUtils.lerp(current.scale, scale, PLAYER_FIT_EASE);
			if (Math.abs(current.lift - lift) < 0.5) current.lift = lift;
			if (Math.abs(current.scale - scale) < 0.001) current.scale = scale;
			const zoom = base * current.scale;
			const { width, height } = state.size;
			const view = cameraRef.view;
			const offset = view?.enabled ? view.offsetY : 0;
			if (
				cameraRef.zoom !== zoom ||
				offset !== current.lift ||
				// Set for the window's size at the time: rotating a phone, or
				// Safari's toolbar coming and going, changes it, and a stale
				// offset skews and shifts the whole view.
				(view?.enabled &&
					(view.fullHeight !== height || view.fullWidth !== width))
			) {
				cameraRef.zoom = zoom;
				if (current.lift) {
					cameraRef.setViewOffset(width, height, 0, current.lift, width, height);
				} else {
					cameraRef.clearViewOffset();
				}

				cameraRef.updateProjectionMatrix();
			}
		}

		if (isMobile || isTouch) {
			if (dotMaterial.current)
				dotMaterial.current.opacity = useStore.getState().polaroidVisible;
		}

		// The spotlight only lights the polaroid frames (the photos are
		// unlit), and mostly diffusely — a frame is brightest when it faces
		// the light. On the choose screen the
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
			// Halved on the choose screen (pan and dolly both): full camera
			// parallax there made the whole stack swing and zoom as one
			// rigid object.
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

	// The phone's tilt, updated in place: Main reads it each frame. As
	// React state it re-rendered the whole scene on every sensor reading
	// (~60 a second), which made the tilt janky.
	const rotation = useRef([0, 0, 0]);
	const setRotation = (r: number[] | undefined) => {
		if (!r) return;
		rotation.current[0] = r[0];
		rotation.current[1] = r[1];
		rotation.current[2] = r[2];
	};

	const onOrientationChange = (e?: ThreeEvent) => {
		if (resetInitialRotation) {
			const r = getRotation(e, [0, 0, 0]);
			setInitialRotation(r as [number, number, number]);
			setResetInitialRotation(false);
			setRotation(r);
		} else {
			setRotation(getRotation(e, initialRotation));
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
			{/* The wake pass can be switched off in debug mode, to measure
			    what it costs; R3F then renders the scene itself. */}
			{wakeEnabled ? <WakePass /> : null}
			{/* Steps the pixel ratio down (toward 1) on a machine that can't
			    hold the frame rate, and back up (to the cap) when it can,
			    from the top. Gradually only: its flip-flop fallback (drop
			    to the floor for good after a few up-and-downs) tripped on
			    brief dips — the wake starting, a swap — and parked a smooth
			    60fps at 1x. Fixed fps bounds: the default scales with the
			    display's refresh rate, so on a 120Hz screen anything under
			    90fps read as struggling. */}
			<PerformanceMonitor
				factor={1}
				flipflops={Infinity}
				bounds={() => [PERF_LOW_FPS, PERF_HIGH_FPS]}
				onChange={({ factor }) => setDprAuto(dprForFactor(factor))}
			/>
			{debug ? <DebugProbe /> : null}
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
					<Main
						video={video}
						position={[0, -h * (1.6 + PLAYER_DROP), 0]}
						tilt={rotation.current}
					/>
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
