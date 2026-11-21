import { LightType } from "@owlbear-rodeo/sdk";

export interface LightConfig {
  attenuationRadius?: number;
  sourceRadius?: number;
  falloff?: number;
  innerAngle?: number;
  outerAngle?: number;
  lightType?: LightType;
  rotation?: number;
  /**
   * How far a primary light can see, in scene pixels.
   * Anything further than this from every primary light is hidden.
   * 0 or undefined means no limit.
   */
  sightRadius?: number;
  /**
   * Radius of the fully bright part of the light, in scene pixels.
   * Between this and the attenuation radius the light is dim.
   * Undefined means the whole light is bright.
   */
  brightRadius?: number;
  /** How strongly the light flickers like a torch, 0 (steady) to 1 */
  flicker?: number;
}
