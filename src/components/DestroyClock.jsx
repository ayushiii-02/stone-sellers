// ModelViewer.jsx
//
// Animation loop:
//   1. IDLE        — solid clock displayed
//   2. EXPLODING   — clock fades, clock stones blast outward
//   3. MORPHING    — clock stones orbit then peel toward % positions
//                    As each stone ARRIVES it shrinks + fades out,
//                    revealing the solid % model underneath.
//   4. REVEALED    — solid % fully visible
//   (loops back to IDLE with solid clock)

import { useRef, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF, Environment } from "@react-three/drei";
import * as THREE from "three";

// ── Config ─────────────────────────────────────────────────────────────────

const CLOCK_PATH  = "/destroy_clock.glb";
const PCT_PATH    = "/destroy_percentage.glb";
const MODEL_SCALE = 5.5;

const IDLE_DUR     = 3.0;
const EXPLODE_DUR  = 1.4;
const MORPH_DUR    = 3.6;
const REVEALED_DUR = 99999;

const MORPH_BLEND_START    = 0.38;
const MORPH_BLEND_END      = 0.93;
const EXPLODE_STAGGER_FRAC = 0.10;
const MORPH_STAGGER_FRAC   = 0.35;
const SCATTER_RADIUS       = 0.28;
const SCATTER_SCALE        = 2.0;

// ── Easing

const ease = {
  outCubic:   (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
  outQuart:   (t) => 1 - (1 - t) ** 4,
  inOutQuart: (t) => t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2,
  smooth:     (t) => t * t * (3 - 2 * t),
};

// ── Seeded RNG 

function createRng(seed) {
  let s = ((seed * 1664525 + 1013904223) >>> 0);
  return () => { s = ((s * 1664525 + 1013904223) >>> 0); return s / 4294967296; };
}

function seededShuffle(arr, rng) {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// ── Parse model shards 

function parseModelShards(scene) {
  const shards = [];
  let origin = null;
  scene.updateWorldMatrix(true, true);
  scene.traverse((obj) => {
    if (!obj.isMesh) return;
    if (!obj.name.toLowerCase().includes("cell")) { origin = obj; return; }
    const box = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    box.getCenter(center);
    shards.push({ mesh: obj, worldCenter: center });
  });
  return { shards, origin };
}

// ── Clone a shard mesh 

function cloneShard(sourceMesh) {
  const c = sourceMesh.clone();
  c.geometry = sourceMesh.geometry;
  c.material = sourceMesh.material.clone();
  c.material.depthWrite = false;
  c.material.transparent = true;
  c.material.opacity = 1;
  c.material.needsUpdate = true;
  c.visible = false;
  c.castShadow = false;
  c.receiveShadow = false;
  c.matrixAutoUpdate = true;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  sourceMesh.matrixWorld.decompose(p, q, s);
  c.userData.baseQuat = q.clone();
  return c;
}

// ── Build per-shard animation data 

function buildShardData(clockShards, pctShards, count) {
  const posRng         = createRng(99991);
  const kickOrder      = seededShuffle([...Array(count).keys()], createRng(42));
  const morphOrder     = seededShuffle([...Array(count).keys()], createRng(88888));
  const explodeStagger = EXPLODE_DUR * EXPLODE_STAGGER_FRAC;
  const blendWindow    = MORPH_BLEND_END - MORPH_BLEND_START;

  return Array.from({ length: count }, (_, i) => {
    const rng       = createRng(i * 7919 + 3571);
    const clockSrc  = clockShards[i].worldCenter.clone().multiplyScalar(MODEL_SCALE);
    const pctTarget = pctShards[i].worldCenter.clone().multiplyScalar(MODEL_SCALE);

    const angle     = posRng() * Math.PI * 2;
    const elevation = (posRng() - 0.5) * Math.PI;
    const radius    = SCATTER_RADIUS * (0.6 + posRng() * 1.4);
    const scattered = clockSrc.clone().add(new THREE.Vector3(
      Math.cos(angle) * Math.cos(elevation) * radius,
      Math.sin(elevation) * radius * 0.55,
      Math.sin(angle) * Math.cos(elevation) * radius * 0.45,
    ));

    const tumbleAxis  = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    const tumbleAngle = (rng() - 0.5) * Math.PI * 1.2;

    const explodeDelay   = (kickOrder.indexOf(i) / Math.max(count - 1, 1)) * explodeStagger;
    const morphDelayFrac = (morphOrder.indexOf(i) / Math.max(count - 1, 1)) * (MORPH_STAGGER_FRAC * blendWindow);

    return { clockSrc, scattered, pctTarget, tumbleAxis, tumbleAngle, explodeDelay, morphDelayFrac };
  });
}

// ── Rotate a point around Y axis

function rotatePointY(vec, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new THREE.Vector3(c * vec.x + s * vec.z, vec.y, -s * vec.x + c * vec.z);
}

// ── StoneField 

function StoneField({ clockShards, pctShards, stateRef, onMorphProgress, onAllLanded }) {
  const count    = Math.min(clockShards.length, pctShards.length);
  const groupRef = useRef();

  const stoneClones = useMemo(
    () => clockShards.slice(0, count).map(({ mesh }) => cloneShard(mesh)),
    [clockShards, count]
  );

  const shardData = useMemo(
    () => buildShardData(clockShards, pctShards, count),
    [clockShards, pctShards, count]
  );

  useEffect(() => {
    const grp = groupRef.current;
    if (!grp) return;
    stoneClones.forEach((c) => grp.add(c));
    return () => stoneClones.forEach((c) => grp?.remove(c));
  }, [stoneClones]);

  const pinnedPos  = useMemo(() => Array.from({ length: count }, (_, i) =>
    // initialise to clockSrc so first morph never reads stale data
    new THREE.Vector3()
  ), [count]);
  const tmpQuat    = useMemo(() => new THREE.Quaternion(), []);
  const landedCount  = useRef(0);
  const hasFiredDone = useRef(false);

  // ── seed pinnedPos to clockSrc positions on mount so morph is always safe
  useEffect(() => {
    shardData.forEach((sd, i) => pinnedPos[i].copy(sd.clockSrc));
  }, [shardData, pinnedPos]);

  useFrame(() => {
    const { phase, elapsed } = stateRef.current;
    const grp = groupRef.current;
    if (!grp) return;

    // ── IDLE: stones hidden, reset pinned positions back to clock origins
    if (phase === "idle") {
      stoneClones.forEach((c, i) => {
        c.visible = false;
        // Reset pinnedPos each idle so next explode starts clean
        pinnedPos[i].copy(shardData[i].clockSrc);
      });
      return;
    }

    // ── REVEALED: stones hidden
    if (phase === "revealed") {
      stoneClones.forEach((c) => { c.visible = false; });
      return;
    }

    // ── EXPLODING
    if (phase === "exploding") {
      stoneClones.forEach((c, i) => {
        const sd      = shardData[i];
        const delayed = Math.max(0, elapsed - sd.explodeDelay);
        const rawT    = Math.min(delayed / (EXPLODE_DUR * 0.70), 1);
        const e       = ease.outCubic(rawT);

        c.visible = true;
        c.material.opacity = 1;
        c.material.transparent = true;

        c.position.lerpVectors(sd.clockSrc, sd.scattered, e);
        c.scale.setScalar(MODEL_SCALE * (1.0 + (SCATTER_SCALE / MODEL_SCALE - 1.0) * e));

        tmpQuat.copy(c.userData.baseQuat ?? new THREE.Quaternion());
        const tumbleQ = new THREE.Quaternion().setFromAxisAngle(sd.tumbleAxis, sd.tumbleAngle * e);
        tmpQuat.premultiply(tumbleQ);
        c.quaternion.copy(tmpQuat);

        // Always keep pinnedPos current so morphing picks up the right spot
        pinnedPos[i].copy(c.position);
      });
      return;
    }

    // ── MORPHING
    if (phase === "morphing") {
      const morphT     = Math.min(elapsed / MORPH_DUR, 1);
      const orbitAngle = ease.inOutQuart(morphT) * Math.PI * 2;

      if (elapsed < 0.016) {
        landedCount.current  = 0;
        hasFiredDone.current = false;
      }

      let totalBlend = 0;

      stoneClones.forEach((c, i) => {
        const sd = shardData[i];

        const blendStart = MORPH_BLEND_START + sd.morphDelayFrac;
        const blendDur   = (MORPH_BLEND_END - MORPH_BLEND_START) * 0.6;
        const blendEnd   = Math.min(blendStart + blendDur, MORPH_BLEND_END);

        let blend = 0;
        if (morphT >= blendStart) {
          const raw = (morphT - blendStart) / Math.max(blendEnd - blendStart, 0.001);
          blend = ease.smooth(Math.min(raw, 1));
        }

        totalBlend += blend;

        const orbitedPos  = rotatePointY(pinnedPos[i], orbitAngle);
        const smoothBlend = ease.inOutQuart(ease.smooth(blend));
        c.position.lerpVectors(orbitedPos, sd.pctTarget, smoothBlend);

        const DISSOLVE_START = 0.55;

        if (!c.visible && blend >= 1) return;
         else if (blend > DISSOLVE_START) {
          const dissolveT = (blend - DISSOLVE_START) / (1.0 - DISSOLVE_START);
          const d         = ease.inOutCubic(dissolveT);
          c.visible = true;
          c.material.transparent = true;
          c.material.opacity     = 1.0 - d;
          c.scale.setScalar(MODEL_SCALE * (1.0 - d * 0.45));
          c.material.needsUpdate = true;
        } else {
          c.visible = true;
          c.material.transparent = true;
          c.material.opacity     = 1;
          const scale = SCATTER_SCALE + (MODEL_SCALE - SCATTER_SCALE) * blend;
          c.scale.setScalar(scale);
        }

        const tumbleAmount = sd.tumbleAngle * (1 - blend);
        tmpQuat.setFromAxisAngle(sd.tumbleAxis, tumbleAmount);
        const orbitSpin = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          orbitAngle * (1 - blend) * 0.3
        );
        tmpQuat.premultiply(orbitSpin);
        c.quaternion.copy(tmpQuat);

        if (blend >= 1) landedCount.current = Math.max(landedCount.current, i + 1);
      });

      onMorphProgress?.(count > 0 ? totalBlend / count : 0);

      if (!hasFiredDone.current && landedCount.current >= count) {
        hasFiredDone.current = true;
        onAllLanded?.();
      }
    }
  });

  return <group ref={groupRef} />;
}

// ── SolidModelReveal 

function SolidModelReveal({ scene, revealPhase, idlePhase, stateRef, morphProgressRef }) {
  const groupRef = useRef();

  const solidMeshes = useMemo(() => {
    const found = [];
    scene.traverse((obj) => {
      if (!obj.isMesh || obj.name.toLowerCase().includes("cell")) return;
      found.push(obj);
    });
    return found;
  }, [scene]);

  useEffect(() => {
    solidMeshes.forEach((mesh) => {
      mesh.material = mesh.material.clone();
      mesh.material.transparent = true;
      mesh.material.opacity = 0;
      mesh.material.roughness = 0.80;
      mesh.material.metalness = 0.12;
      mesh.material.envMapIntensity = 0.55;
      mesh.material.needsUpdate = true;
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  }, [solidMeshes]);

  useFrame(() => {
    if (!groupRef.current) return;
    const { phase } = stateRef.current;

    if (phase === revealPhase) {
      const progress = morphProgressRef.current;
      const total    = solidMeshes.length;
      solidMeshes.forEach((mesh, i) => {
        const threshold = i / total;
        if (progress > threshold) {
          const localT = THREE.MathUtils.clamp(
            (progress - threshold) * total * 0.35, 0, 1
          );
          const eased = ease.inOutQuart(localT);
          mesh.visible = true;
          mesh.material.transparent = eased < 1;
          mesh.material.opacity = eased;
          mesh.material.needsUpdate = true;
        } else {
          mesh.visible = false;
        }
      });

    } else if (phase === "revealed" && idlePhase === "idle") {
      solidMeshes.forEach((mesh) => {
        mesh.visible = true;
        mesh.material.transparent = false;
        mesh.material.opacity = 1;
        mesh.material.needsUpdate = true;
      });

    } else if (phase === idlePhase) {
      solidMeshes.forEach((mesh) => {
        mesh.visible = true;
        mesh.material.transparent = false;
        mesh.material.opacity = 1;
        mesh.material.needsUpdate = true;
      });

    } else {
      // idle / exploding — hidden
      solidMeshes.forEach((mesh) => {
        mesh.visible = false;
        mesh.material.transparent = true;
        mesh.material.opacity = 0;
        mesh.material.needsUpdate = true;
      });
    }

    groupRef.current.scale.setScalar(MODEL_SCALE);
  });

  if (!solidMeshes.length) return null;
  return (
    <group ref={groupRef}>
      {solidMeshes.map((mesh, i) => <primitive key={i} object={mesh} />)}
    </group>
  );
}

// ── ModelViewer 

export default function ModelViewer() {
  const { scene: clockScene } = useGLTF(CLOCK_PATH);
  const { scene: pctScene   } = useGLTF(PCT_PATH);

  const { shards: clockShards, origin: clockOrigin } = useMemo(
    () => parseModelShards(clockScene), [clockScene]
  );
  const { shards: pctShards } = useMemo(
    () => parseModelShards(pctScene), [pctScene]
  );

  const groupRef         = useRef();
  const clockOriginRef   = useRef();
  const morphProgressRef = useRef(0);
  const animState        = useRef({ phase: "idle", elapsed: 0 });
  const { gl }           = useThree();

  const tilt       = useRef({ x: 0, y: 0.35 });
  const targetTilt = useRef({ x: 0, y: 0.35 });

  useEffect(() => {
    [clockScene, pctScene].forEach((scene) => {
      scene.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.material = obj.material.clone();
        obj.material.roughness = 0.85;
        obj.material.metalness = 0.08;
        obj.material.envMapIntensity = 0.45;
        obj.material.transparent = true;
        obj.material.opacity = 1;
        obj.material.needsUpdate = true;
      });
      scene.traverse((obj) => {
        if (obj.isMesh && obj.name.toLowerCase().includes("cell"))
          obj.visible = false;
      });
    });
  }, [clockScene, pctScene]);

  useEffect(() => {
    const canvas = gl.domElement;
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      targetTilt.current.x = -((e.clientY - r.top)  / r.height * 2 - 1) * 0.18;
      targetTilt.current.y =  0.35 + ((e.clientX - r.left) / r.width * 2 - 1) * 0.22;
    };
    const onLeave = () => { targetTilt.current.x = 0; targetTilt.current.y = 0.35; };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, [gl]);

  const resetToIdle = (clockOrigin, clockOriginRef) => {
    morphProgressRef.current = 0;
    animState.current.phase   = "idle";
    animState.current.elapsed = 0;

    // ── FIX: restore clock body so it's visible again on loop
    if (clockOrigin?.material) {
      clockOrigin.material.opacity = 1;
      clockOrigin.material.transparent = false;
      clockOrigin.material.needsUpdate = true;
    }
    if (clockOriginRef.current) {
      clockOriginRef.current.visible = true;
    }
  };

  useFrame((_, delta) => {
    tilt.current.x += (targetTilt.current.x - tilt.current.x) * 0.05;
    tilt.current.y += (targetTilt.current.y - tilt.current.y) * 0.05;
    if (groupRef.current) {
      groupRef.current.rotation.x = tilt.current.x;
      groupRef.current.rotation.y = tilt.current.y;
    }

    const st = animState.current;
    st.elapsed += delta;

    if (st.phase === "idle" && st.elapsed >= IDLE_DUR) {
      st.phase = "exploding"; st.elapsed = 0;
    }

    if (st.phase === "exploding") {
      const fade = Math.max(0, 1 - st.elapsed / (EXPLODE_DUR * 0.15));
      if (clockOrigin?.material) clockOrigin.material.opacity = fade;
      if (clockOriginRef.current) clockOriginRef.current.visible = fade > 0.01;

      if (st.elapsed >= EXPLODE_DUR) {
        st.phase = "morphing"; st.elapsed = 0;
        if (clockOriginRef.current) clockOriginRef.current.visible = false;
      }
    }

    if (st.phase === "morphing" && st.elapsed >= MORPH_DUR + 0.5) {
      st.phase = "revealed"; st.elapsed = 0;
    }

    // if (st.phase === "revealed" && st.elapsed >= REVEALED_DUR) {
    //   resetToIdle(clockOrigin, clockOriginRef);
    // }
  });

  return (
    <>
      <Environment preset="studio" environmentIntensity={0.18} />
      <ambientLight intensity={0.07} />
      <directionalLight position={[4, 6, 5]} intensity={0.90} castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.1} shadow-camera-far={50}
        shadow-camera-left={-10} shadow-camera-right={10}
        shadow-camera-top={10}  shadow-camera-bottom={-10} />
      <directionalLight position={[-3, 2, 3]} intensity={0.20} color="#8aa0cc" />
      <pointLight position={[0, -3, 2]}  intensity={0.12} />
      <pointLight position={[3,  1, -3]} intensity={0.28} color="#ffe4cc" />
      <pointLight position={[-3, 2, -2]} intensity={0.20} color="#d4f0ff" />

      <group ref={groupRef}>
        <group ref={clockOriginRef}>
          <primitive object={clockScene} scale={MODEL_SCALE} />
        </group>

        <StoneField
          clockShards={clockShards}
          pctShards={pctShards}
          stateRef={animState}
          onMorphProgress={(avg) => { morphProgressRef.current = avg; }}
          onAllLanded={() => {
            if (animState.current.phase === "morphing") {
              animState.current.phase   = "revealed";
              animState.current.elapsed = 0;
            }
          }}
        />

        <SolidModelReveal
          scene={pctScene}
          revealPhase="morphing"
          idlePhase="revealed"
          stateRef={animState}
          morphProgressRef={morphProgressRef}
        />
      </group>
    </>
  );
}

useGLTF.preload(CLOCK_PATH);
useGLTF.preload(PCT_PATH);