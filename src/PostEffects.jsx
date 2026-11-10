import React, { useCallback, useRef } from 'react'
import { EffectComposer, N8AO, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import {
  AO_SETTINGS, BLOOM_SETTINGS, COMPOSER_MULTISAMPLING, disposeN8AONestedMaterials,
} from './scene-postprocessing'

// V7: the Mac-only pass chain — N8AO grounds the furniture, a subtle bloom
// lifts lamps/screens, AgX tone mapping restores the canvas grade the composer
// bypasses. Loaded lazily from OfficeScene so phone tiers, which never mount
// it, never download or parse the postprocessing bundle either.
export default function MacPostEffects() {
  const lastAOPass = useRef(null)
  // The library's useDispose only runs the pass's own dispose() on unmount,
  // which misses the six ShaderMaterials nested inside N8AO's fullscreen
  // quads. React detaches callback refs (calls with null) on unmount and
  // before attaching a replacement pass, so both the quality-downgrade
  // unmount and an in-place pass swap release the previous pass's materials.
  // Disposed materials recompile on next use, so a dev StrictMode
  // detach/re-attach of the same live pass stays harmless.
  const aoCleanupRef = useCallback(pass => {
    if (lastAOPass.current && lastAOPass.current !== pass) {
      disposeN8AONestedMaterials(lastAOPass.current)
    }
    lastAOPass.current = pass
  }, [])
  return <EffectComposer multisampling={COMPOSER_MULTISAMPLING}>
    <N8AO ref={aoCleanupRef} {...AO_SETTINGS}/>
    <Bloom {...BLOOM_SETTINGS}/>
    <ToneMapping mode={ToneMappingMode.AGX}/>
  </EffectComposer>
}
