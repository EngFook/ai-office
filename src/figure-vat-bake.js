// V8a: bake the Quaternius character into a vertex-animation texture (VAT).
// Runs once at load (also headless under node for tests): plays each clip on
// the rig, skins every kept vertex on the CPU and writes the world-space
// positions into one float texture row per frame. The two seated clips are
// posed procedurally here because the CC0 pack has no sitting animation.
// Rendering then needs a single InstancedMesh: the vertex shader fetches the
// figure's current rows and lerps, so the whole crowd is one draw call.
import * as THREE from 'three'
import { DROPPED_MESHES, TINTED_MATERIALS, FIGURE_CLIPS, FIGURE_HEIGHT, SEAT_PELVIS_Y, VAT_FPS, vatLayout, vatRows } from './figure-vat.js'

// --- Procedural seated poses -------------------------------------------------
// World-space deltas applied on top of the idle clip's first frame. Angles
// rotate about world +X in the model's frame (the character faces +Z, so a
// negative angle swings a hanging limb forward, a positive torso angle
// hunches forward). osc() terms use whole cycles per loop so the clip tiles.
// The rig is IK-style: the leg bones hang from "Body" while the feet are
// parented to "Root", so the pose raises Body to the seat, swings the
// thighs, keeps the shins hanging and then re-plants the feet at the end of
// the shin (legs dangle: the chibi legs are far shorter than a chair).
const SIT_POSES = {
  sitTyping: {
    pelvisBack: -0.12, torso: 0.14, head: 0.10,
    upperArm: -0.70, lowerArm: -0.45,
    // forearm typing beat, opposite phase per side (4 cycles over the loop)
    lowerArmOsc: { amp: 0.14, cycles: 4, sidePhase: Math.PI },
    torsoOsc: { amp: 0.02, cycles: 2, sidePhase: 0 },
    thigh: -0.9,
  },
  sitLounge: {
    pelvisBack: -0.18, torso: -0.20, head: -0.04,
    upperArm: -0.25, lowerArm: -0.35,
    lowerArmOsc: null,
    // slow breathing sway (1 cycle over the loop)
    torsoOsc: { amp: 0.035, cycles: 1, sidePhase: 0 },
    thigh: -0.72,
  },
}

const X_AXIS = new THREE.Vector3(1, 0, 0)

function collectMeshes(scene) {
  const meshes = []
  scene.traverse(object => { if (object.isSkinnedMesh && !DROPPED_MESHES.has(object.name)) meshes.push(object) })
  return meshes
}

function boneByName(scene) {
  const bones = new Map()
  scene.traverse(object => { if (object.isBone) bones.set(object.name, object) })
  return bones
}

// Snapshot of the idle base frame every seated pose builds on.
function captureBase(scene, names) {
  const bones = boneByName(scene)
  const base = new Map()
  for (const name of names) {
    const bone = bones.get(name)
    if (!bone) continue
    base.set(name, {
      bone,
      worldQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
      worldPos: bone.getWorldPosition(new THREE.Vector3()),
    })
  }
  return base
}

const POSED_BONES = ['Body', 'Hips', 'Torso', 'Head', 'UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR',
  'UpperLegL', 'UpperLegR', 'LowerLegL', 'LowerLegR', 'FootL', 'FootR', 'Root']

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _m = new THREE.Matrix4(), _v = new THREE.Vector3()

// Set a bone so its world orientation becomes delta * (its idle base world
// orientation); ancestors must already be posed (applied parent-first).
function orientFromBase(entry, delta) {
  const bone = entry.bone
  bone.parent.updateWorldMatrix(true, false)
  _pq.setFromRotationMatrix(_m.extractRotation(bone.parent.matrixWorld))
  bone.quaternion.copy(_pq.invert()).multiply(delta).multiply(entry.worldQuat)
}

// Move a bone so its world position becomes `target` (orientation untouched).
function placeAtWorld(entry, target) {
  const bone = entry.bone
  bone.parent.updateWorldMatrix(true, false)
  bone.position.copy(target).applyMatrix4(_m.copy(bone.parent.matrixWorld).invert())
}

const osc = (spec, phase, side = 0) => spec ? spec.amp * Math.sin(Math.PI * 2 * spec.cycles * phase + side * spec.sidePhase) : 0

// Apply one seated pose frame (phase in [0, 1)) on top of the idle base.
export function applySitPose(base, pose, phase, pelvisTargetY) {
  const hips = base.get('Hips')
  const lift = _v.set(0, pelvisTargetY - hips.worldPos.y, pose.pelvisBack).clone()
  // Body carries hips+torso+legs (feet hang from Root instead): raise it.
  placeAtWorld(base.get('Body'), base.get('Body').worldPos.clone().add(lift))
  orientFromBase(base.get('Torso'), _q.setFromAxisAngle(X_AXIS, pose.torso + osc(pose.torsoOsc, phase)))
  orientFromBase(base.get('Head'), _q.setFromAxisAngle(X_AXIS, pose.head))
  for (const [side, suffix] of [[0, 'L'], [1, 'R']]) {
    orientFromBase(base.get('UpperArm' + suffix), _q.setFromAxisAngle(X_AXIS, pose.upperArm))
    orientFromBase(base.get('LowerArm' + suffix), _q.setFromAxisAngle(X_AXIS, pose.lowerArm + osc(pose.lowerArmOsc, phase, side)))
    const hipJoint = base.get('UpperLeg' + suffix), knee = base.get('LowerLeg' + suffix), foot = base.get('Foot' + suffix)
    const thighDelta = _q.setFromAxisAngle(X_AXIS, pose.thigh)
    orientFromBase(hipJoint, thighDelta)
    orientFromBase(knee, new THREE.Quaternion()) // shin keeps hanging straight down
    // Re-plant the foot at the end of the swung thigh + hanging shin.
    const kneeNew = knee.worldPos.clone().sub(hipJoint.worldPos).applyQuaternion(thighDelta).add(hipJoint.worldPos).add(lift)
    placeAtWorld(foot, kneeNew.add(foot.worldPos).sub(knee.worldPos))
  }
}

// --- The bake ----------------------------------------------------------------
// Returns everything the renderer needs: merged geometry (rest positions for
// raycasting, flat colours, tint mask), the float VAT texture, the layout by
// clip id and the uniform scale that maps the model to FIGURE_HEIGHT.
export function bakeFigureVat(gltf, { fps = VAT_FPS } = {}) {
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const meshes = collectMeshes(scene)

  // Merged static attributes. Each GLTF primitive arrived as its own
  // single-material SkinnedMesh, so colours are constant per mesh.
  const ranges = []
  let vertexCount = 0, indexCount = 0
  for (const mesh of meshes) {
    ranges.push({ mesh, start: vertexCount })
    vertexCount += mesh.geometry.attributes.position.count
    indexCount += mesh.geometry.index.count
  }
  const colors = new Float32Array(vertexCount * 3)
  const tint = new Float32Array(vertexCount)
  const index = new Uint32Array(indexCount)
  let offset = 0
  for (const { mesh, start } of ranges) {
    const count = mesh.geometry.attributes.position.count
    const tinted = TINTED_MATERIALS.has(mesh.material.name)
    const color = tinted ? { r: 1, g: 1, b: 1 } : mesh.material.color
    for (let i = 0; i < count; i++) {
      colors.set([color.r, color.g, color.b], (start + i) * 3)
      tint[start + i] = tinted ? 1 : 0
    }
    const meshIndex = mesh.geometry.index
    for (let i = 0; i < meshIndex.count; i++) index[offset++] = start + meshIndex.getX(i)
  }

  // Layout: embedded clip durations replace the nominal ones.
  const clips = FIGURE_CLIPS.map(clip => {
    if (!clip.source) return clip
    const embedded = gltf.animations.find(animation => animation.name === clip.source)
    if (!embedded) throw new Error(`figure clip missing from GLB: ${clip.source}`)
    return { ...clip, duration: embedded.duration }
  })
  const layout = vatLayout(clips, fps)
  const rows = vatRows(layout)
  const data = new Float32Array(vertexCount * rows * 4)

  const mixer = new THREE.AnimationMixer(scene)
  const sample = row => {
    scene.updateMatrixWorld(true)
    for (const { mesh, start } of ranges) {
      mesh.skeleton.update()
      const position = mesh.geometry.attributes.position
      for (let i = 0; i < position.count; i++) {
        _v.fromBufferAttribute(position, i)
        mesh.applyBoneTransform(i, _v).applyMatrix4(mesh.matrixWorld)
        data.set([_v.x, _v.y, _v.z, 1], (row * vertexCount + start + i) * 4)
      }
    }
  }

  const idleClip = gltf.animations.find(animation => animation.name === FIGURE_CLIPS[0].source)
  const idleAction = mixer.clipAction(idleClip)
  // Model height (ears dropped) from the idle base frame decides the scale;
  // the seated pelvis height converts through it into model units.
  idleAction.play(); mixer.setTime(0); scene.updateMatrixWorld(true)
  const base = captureBase(scene, POSED_BONES)
  // Local-transform snapshot of the whole rig at the idle base: restored
  // before every procedural frame and every clip, so a pose delta or an
  // untracked bone can never leak from one baked row into another.
  const snapshot = []
  scene.traverse(object => {
    if (object.isBone) snapshot.push({ bone: object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() })
  })
  const restoreBase = () => {
    for (const { bone, position, quaternion, scale: boneScale } of snapshot) {
      bone.position.copy(position); bone.quaternion.copy(quaternion); bone.scale.copy(boneScale)
    }
  }
  let maxY = 0
  for (const { mesh } of ranges) {
    mesh.skeleton.update()
    const position = mesh.geometry.attributes.position
    for (let i = 0; i < position.count; i++) {
      _v.fromBufferAttribute(position, i)
      maxY = Math.max(maxY, mesh.applyBoneTransform(i, _v).applyMatrix4(mesh.matrixWorld).y)
    }
  }
  const scale = FIGURE_HEIGHT / maxY
  const pelvisTargetY = SEAT_PELVIS_Y / scale
  idleAction.stop()

  for (const range of layout) {
    if (range.source) {
      restoreBase()
      const action = mixer.clipAction(gltf.animations.find(animation => animation.name === range.source))
      action.play()
      for (let frame = 0; frame <= range.frames; frame++) {
        mixer.setTime((frame % range.frames) / fps)
        sample(range.start + frame)
      }
      action.stop()
      mixer.setTime(0)
    } else {
      const pose = SIT_POSES[range.id]
      for (let frame = 0; frame <= range.frames; frame++) {
        // Reset to the idle base, then pose; the wrap row repeats phase 0.
        restoreBase()
        applySitPose(base, pose, (frame % range.frames) / range.frames, pelvisTargetY)
        sample(range.start + frame)
      }
      restoreBase()
    }
  }

  const geometry = new THREE.BufferGeometry()
  // Rest positions = idle frame 0: instance raycasting (click to select a
  // person) tests against this natural standing pose.
  const rest = new Float32Array(vertexCount * 3)
  const idleStart = layout[0].start * vertexCount * 4
  for (let i = 0; i < vertexCount; i++) rest.set(data.subarray(idleStart + i * 4, idleStart + i * 4 + 3), i * 3)
  geometry.setAttribute('position', new THREE.BufferAttribute(rest, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 1))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingSphere()

  const texture = new THREE.DataTexture(data, vertexCount, rows, THREE.RGBAFormat, THREE.FloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true

  const layoutById = Object.fromEntries(layout.map(range => [range.id, range]))
  return { geometry, texture, layout: layoutById, scale, vertexCount, triangles: indexCount / 3 }
}

// --- Material patch ----------------------------------------------------------
// Replaces the vertex position with the VAT lookup (two texelFetch rows,
// lerped by the fractional per-instance frame) and limits the instance
// colour to the tint-masked (team shirt) vertices. Applied to both the lit
// material and the custom depth material so shadows follow the animation.
export function patchFigureMaterial(material, texture) {
  material.onBeforeCompile = shader => {
    shader.uniforms.vatTexture = { value: texture }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2D vatTexture;
        attribute float aVatFrame;
        attribute float aTint;`)
      .replace('#include <begin_vertex>', `
        int vatRow = int(aVatFrame);
        vec3 vatA = texelFetch(vatTexture, ivec2(gl_VertexID, vatRow), 0).xyz;
        vec3 vatB = texelFetch(vatTexture, ivec2(gl_VertexID, vatRow + 1), 0).xyz;
        vec3 transformed = mix(vatA, vatB, aVatFrame - float(vatRow));`)
      .replace('#include <color_vertex>', `
        #if defined( USE_COLOR )
          vColor = vec3( 1.0 );
          vColor *= color;
          #ifdef USE_INSTANCING_COLOR
            vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aTint);
          #endif
        #endif`)
  }
  // The patch must never be shared with a cached program of the same shader.
  material.customProgramCacheKey = () => 'figure-vat'
  return material
}
