import OBR, {
  buildEffect,
  isEffect,
  Item,
  Matrix,
  Uniform,
} from "@owlbear-rodeo/sdk";
import { LightConfig } from "../types/LightConfig";
import { getMetadata } from "../util/getMetadata";
import { getPluginId } from "../util/getPluginId";

import previewOffIcon from "../assets/preview-off.svg";
import previewOnIcon from "../assets/preview-on.svg";

const FOG_TOOL = "rodeo.owlbear.tool/fog";
const PREVIEW_KEY = getPluginId("player-preview");

/**
 * The darkness layer is a single viewport effect drawn above the fog.
 * Owlbear Rodeo draws the fog itself and a light only has a radius and an edge,
 * so sight distance, brightness gradients and flicker are all done here by
 * painting the fog color back over the parts of the map that should be dim or unseen.
 *
 * Effect uniforms can't be arrays so lights are packed three to a mat3 and the
 * shader is generated for a fixed number of slots.
 */

// Each mat3 holds three entries of (x, y, value)
const LIGHT_UNIFORMS = 16;
const SIGHT_UNIFORMS = 6;
export const MAX_LIGHTS = LIGHT_UNIFORMS * 3;
export const MAX_SIGHTS = SIGHT_UNIFORMS * 3;

// The GM sees a lighter version of the darkness so the map stays readable
const GM_STRENGTH = 0.8;
// How visible things beyond the sight distance stay for the GM, players see none of it
const GM_UNSEEN = 0.55;

// Bright fraction and flicker are each stored in 4 bits
const STEPS = 15;

// The shader is built for the smallest of these sizes that fits the scene
// so that a handful of lights doesn't pay for all of the slots
const LIGHT_SIZES = [1, 2, 4, 8, LIGHT_UNIFORMS];
const SIGHT_SIZES = [0, 1, 2, SIGHT_UNIFORMS];

function fit(count: number, sizes: number[]) {
  return sizes.find((size) => size * 3 >= count) ?? sizes[sizes.length - 1];
}

/**
 * @param lightSize How many light mat3 uniforms to include
 * @param sightSize How many sight mat3 uniforms to include
 * @param animated Whether any light flickers, a steady scene skips the animation
 */
export function buildSksl(
  lightSize = LIGHT_UNIFORMS,
  sightSize = SIGHT_UNIFORMS,
  animated = true
) {
  const lightUniforms: string[] = [];
  const lightCalls: string[] = [];
  for (let i = 0; i < lightSize; i++) {
    lightUniforms.push(`uniform mat3 l${i};`);
    for (let j = 0; j < 3; j++) {
      const seed = (i * 3 + j + 1).toFixed(1);
      lightCalls.push(`  addLight(level, cover, p, l${i}[${j}], ${seed});`);
    }
  }
  const sightUniforms: string[] = [];
  const sightCalls: string[] = [];
  for (let i = 0; i < sightSize; i++) {
    sightUniforms.push(`uniform mat3 s${i};`);
    for (let j = 0; j < 3; j++) {
      sightCalls.push(`  addSight(sight, p, s${i}[${j}]);`);
    }
  }

  return `
uniform mat3 model;
${animated ? "uniform float time;" : ""}
uniform vec3 fogColor;
uniform float strength;
uniform float sightOn;
uniform float unseen;
${lightUniforms.join("\n")}
${sightUniforms.join("\n")}

${
  animated
    ? `float hash(float n) {
  return fract(sin(n) * 43758.5453);
}

float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}

// A slow sway with faster jitter on top, returns 0 to 1
float flame(float seed) {
  return 0.55 * noise(time * 2.3 + seed * 17.0) +
    0.3 * noise(time * 6.1 + seed * 31.0) +
    0.15 * noise(time * 14.0 + seed * 5.0);
}`
    : `float flame(float seed) {
  return 1.0;
}`
}

// l is (x, y, radius + code / 256) where code is bright * 16 + flicker
void addLight(inout float level, inout float cover, vec2 p, vec3 l, float seed) {
  float radius = floor(l.z);
  vec2 offset = p - l.xy;
  // Most pixels are nowhere near most lights so leave before doing any real work.
  // 1.21 is the square of 1.1, the furthest a light's dimming reaches.
  if (radius <= 0.0 || dot(offset, offset) > radius * radius * 1.21) {
    return;
  }
  float code = floor(fract(l.z) * 256.0 + 0.5);
  float brightCode = floor(code / 16.0);
  // The fraction of the radius that is fully bright
  float bright = brightCode / 15.0;
  // How strong the flicker is, 0 to 1
  float flicker = (code - brightCode * 16.0) / 15.0;
  // How far the flame has dipped right now, 0 to 1
  float dip = 0.0;
  if (flicker > 0.0) {
    dip = flicker * (1.0 - flame(seed));
  }
  float d = length(offset);

  if (bright < 0.999) {
    // A flickering light also breathes in and out
    float r = radius * (1.0 - 0.22 * dip);
    float t = clamp(d / r, 0.0, 1.0);
    // Bright in the middle, stepping down to dim, then fading out at the edge
    float brightness = mix(1.0, 0.4, smoothstep(bright - 0.05, bright + 0.12, t));
    brightness *= 1.0 - 0.92 * smoothstep(0.7, 1.0, t);
    level = max(level, brightness * (1.0 - 0.4 * dip));
    cover = max(cover, 1.0 - smoothstep(1.0, 1.1, d / radius));
  } else {
    float inside = 1.0 - smoothstep(0.95, 1.0, d / radius);
    level = max(level, inside * (1.0 - 0.45 * dip));
    if (flicker > 0.0) {
      cover = max(cover, inside);
    }
  }
}

// s is (x, y, sight radius)
void addSight(inout float sight, vec2 p, vec3 s) {
  if (s.z <= 0.0) {
    return;
  }
  float d = length(p - s.xy);
  sight = max(sight, 1.0 - smoothstep(0.92, 1.0, d / s.z));
}

half4 main(float2 coord) {
  vec2 p = (model * vec3(coord, 1.0)).xy;

  float level = 0.0;
  float cover = 0.0;
${lightCalls.join("\n")}
  // Only dim where a gradient or flickering light reaches
  float brightness = mix(1.0, level, cover);

  float sight = 0.0;
${sightCalls.join("\n")}
  // unseen is 0 for players, the GM still sees a little beyond the sight distance
  float seen = sightOn > 0.5 ? max(sight, unseen) : 1.0;

  float alpha = clamp((1.0 - brightness * seen) * strength, 0.0, 1.0);
  return half4(fogColor * alpha, alpha);
}
`;
}

interface DarknessLight {
  x: number;
  y: number;
  radius: number;
  // Fraction of the radius that is bright in steps, STEPS means all of it
  bright: number;
  // Flicker strength in steps, 0 means steady
  flicker: number;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

interface DarknessSight {
  x: number;
  y: number;
  radius: number;
}

function parseColor(color: string): [number, number, number] {
  let hex = color.trim().replace("#", "");
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const value = parseInt(hex.slice(0, 6), 16);
  if (hex.length < 6 || Number.isNaN(value)) {
    return [0.13, 0.13, 0.13];
  }
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

function pack(entries: [number, number, number][], count: number): Matrix[] {
  const matrices: Matrix[] = [];
  for (let i = 0; i < count; i++) {
    const values: number[] = [];
    for (let j = 0; j < 3; j++) {
      const entry = entries[i * 3 + j] ?? [0, 0, 0];
      values.push(...entry);
    }
    matrices.push(values as Matrix);
  }
  return matrices;
}

/** Work out what the darkness layer needs to draw for the current scene items */
export function getDarknessState(items: Item[]) {
  const lights: DarknessLight[] = [];
  const sights: DarknessSight[] = [];
  const primaries: { x: number; y: number; radius: number; sight: number }[] =
    [];

  for (const item of items) {
    if (!(getPluginId("light") in item.metadata) || !item.visible) {
      continue;
    }
    const config = getMetadata<LightConfig>(
      item.metadata,
      getPluginId("light"),
      {}
    );
    const radius = config.attenuationRadius ?? 0;
    if (radius <= 0) {
      continue;
    }
    const bright =
      typeof config.brightRadius === "number"
        ? clamp01(config.brightRadius / radius)
        : 1;
    const flicker =
      typeof config.flicker === "number" ? clamp01(config.flicker) : 0;
    lights.push({
      x: item.position.x,
      y: item.position.y,
      radius,
      bright: Math.round(bright * STEPS),
      flicker: Math.round(flicker * STEPS),
    });
    if (config.lightType === undefined || config.lightType === "PRIMARY") {
      primaries.push({
        x: item.position.x,
        y: item.position.y,
        radius,
        sight: config.sightRadius ?? 0,
      });
    }
  }

  // Sight is limited once any primary light has a sight distance.
  // A primary without one can still see as far as its own light.
  const sightOn = primaries.some((primary) => primary.sight > 0);
  if (sightOn) {
    for (const primary of primaries) {
      sights.push({
        x: primary.x,
        y: primary.y,
        radius: primary.sight > 0 ? primary.sight : primary.radius,
      });
    }
  }

  const distanceToSight = (light: DarknessLight) => {
    let min = Infinity;
    for (const sight of sights) {
      const d = Math.hypot(light.x - sight.x, light.y - sight.y);
      min = Math.min(min, d - sight.radius);
    }
    return min;
  };
  const distanceToPrimary = (light: DarknessLight) => {
    let min = primaries.length === 0 ? 0 : Infinity;
    for (const primary of primaries) {
      min = Math.min(min, Math.hypot(light.x - primary.x, light.y - primary.y));
    }
    return min;
  };

  // Lights that are completely out of sight never need a slot
  const candidates = sightOn
    ? lights.filter((light) => distanceToSight(light) < light.radius * 1.3)
    : lights;
  // When there are more lights than slots keep the ones closest to the characters
  const ranked = candidates
    .map((light) => ({ light, distance: distanceToPrimary(light) }))
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.light);

  const hasEffects = lights.some(
    (light) => light.bright < STEPS || light.flicker > 0
  );

  return {
    active: sightOn || hasEffects,
    sightOn,
    lights: ranked.slice(0, MAX_LIGHTS),
    sights: sights.slice(0, MAX_SIGHTS),
    dropped:
      Math.max(0, ranked.length - MAX_LIGHTS) +
      Math.max(0, sights.length - MAX_SIGHTS),
  };
}

function getUniforms(
  state: ReturnType<typeof getDarknessState>,
  fogColor: string,
  strength: number,
  unseen: number,
  lightSize: number,
  sightSize: number
): Uniform[] {
  const [r, g, b] = parseColor(fogColor);
  const uniforms: Uniform[] = [
    { name: "fogColor", value: { x: r, y: g, z: b } },
    { name: "strength", value: strength },
    { name: "sightOn", value: state.sightOn ? 1 : 0 },
    { name: "unseen", value: unseen },
  ];
  const lights = pack(
    state.lights.map((light) => [
      light.x,
      light.y,
      // The settings ride in the fraction of the radius
      Math.max(1, Math.floor(light.radius)) +
        (light.bright * 16 + light.flicker) / 256,
    ]),
    lightSize
  );
  lights.forEach((value, i) => uniforms.push({ name: `l${i}`, value }));
  const sights = pack(
    state.sights.map((sight) => [sight.x, sight.y, sight.radius]),
    sightSize
  );
  sights.forEach((value, i) => uniforms.push({ name: `s${i}`, value }));
  return uniforms;
}

export function initDarkness() {
  // The shader currently on the effect and the sizes it was built for
  let sksl = "";
  let skslKey = "";
  let effectId: string | null = null;
  let lastUniforms = "";
  let ready = false;
  let items: Item[] = [];
  let fogColor = "#222222";
  let strength = 1;
  let unseen = 0;
  let warned = false;
  // Changes are applied one at a time so that an add can't race a delete
  let queue: Promise<void> = Promise.resolve();

  async function apply() {
    if (!ready) {
      // Local items are cleared with the scene
      effectId = null;
      lastUniforms = "";
      return;
    }
    const state = getDarknessState(items);
    if (state.dropped > 0 && !warned) {
      warned = true;
      console.warn(
        `Dynamic Fog: ${state.dropped} lights are beyond the ${MAX_LIGHTS} lights and ${MAX_SIGHTS} sight ranges the darkness layer supports`
      );
    }

    if (!state.active) {
      if (effectId) {
        await OBR.scene.local.deleteItems([effectId]);
        effectId = null;
        lastUniforms = "";
      }
      return;
    }

    const lightSize = fit(state.lights.length, LIGHT_SIZES);
    const sightSize = fit(state.sights.length, SIGHT_SIZES);
    const animated = state.lights.some((light) => light.flicker > 0);
    const key = `${lightSize}/${sightSize}/${animated}`;
    const rebuilt = key !== skslKey;
    if (rebuilt) {
      sksl = buildSksl(lightSize, sightSize, animated);
      skslKey = key;
    }

    const uniforms = getUniforms(
      state,
      fogColor,
      strength,
      unseen,
      lightSize,
      sightSize
    );
    const serialized = JSON.stringify(uniforms);
    if (effectId && !rebuilt && serialized === lastUniforms) {
      return;
    }

    if (effectId && rebuilt) {
      // A different shader gets a fresh effect rather than an in place swap
      await OBR.scene.local.deleteItems([effectId]);
      effectId = null;
    }

    if (effectId) {
      await OBR.scene.local.updateItems([effectId], (effects) => {
        for (const effect of effects) {
          if (isEffect(effect)) {
            effect.uniforms = uniforms;
          }
        }
      });
    } else {
      const effect = buildEffect()
        .effectType("VIEWPORT")
        .layer("POINTER")
        .zIndex(0)
        .disableAutoZIndex(true)
        .blendMode("SRC_OVER")
        .sksl(sksl)
        .uniforms(uniforms)
        .locked(true)
        .disableHit(true)
        .metadata({ [getPluginId("darkness")]: true })
        .build();
      await OBR.scene.local.addItems([effect]);
      effectId = effect.id;
    }
    lastUniforms = serialized;
  }

  function schedule() {
    queue = queue.then(apply).catch((error) => {
      console.error("Dynamic Fog: unable to update the darkness layer", error);
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      OBR.notification.show(`Darkness layer failed: ${message}`, "ERROR");
    });
  }

  async function handleReady(isReady: boolean) {
    ready = isReady;
    if (isReady) {
      items = await OBR.scene.items.getItems();
      fogColor = await OBR.scene.fog.getColor();
    } else {
      items = [];
    }
    schedule();
  }

  let role: "GM" | "PLAYER" = "PLAYER";
  // When on the GM sees the darkness exactly as a player does
  let preview = false;
  function updateStrength() {
    const lighter = role === "GM" && !preview;
    strength = lighter ? GM_STRENGTH : 1;
    unseen = lighter ? GM_UNSEEN : 0;
  }
  function setRole(next: "GM" | "PLAYER") {
    role = next;
    updateStrength();
  }

  // Owlbear Rodeo's own fog preview setting isn't available to extensions
  // so the fog tool gets a matching toggle for the darkness layer
  OBR.tool.getMetadata(FOG_TOOL).then((metadata) => {
    preview = metadata?.[PREVIEW_KEY] === true;
    updateStrength();
    schedule();
  });
  OBR.tool.createAction({
    id: getPluginId("player-preview-action"),
    icons: [
      {
        icon: previewOffIcon,
        label: "Preview Darkness as Player",
        filter: {
          activeTools: [FOG_TOOL],
          roles: ["GM"],
          metadata: [{ key: PREVIEW_KEY, value: true, operator: "!=" }],
        },
      },
      {
        icon: previewOnIcon,
        label: "Stop Previewing Darkness as Player",
        filter: {
          activeTools: [FOG_TOOL],
          roles: ["GM"],
          metadata: [{ key: PREVIEW_KEY, value: true }],
        },
      },
    ],
    onClick() {
      preview = !preview;
      OBR.tool.setMetadata(FOG_TOOL, { [PREVIEW_KEY]: preview });
      updateStrength();
      schedule();
    },
  });

  OBR.player.getRole().then((next) => {
    setRole(next);
    schedule();
  });
  OBR.scene.isReady().then(handleReady);

  const subscriptions = [
    OBR.scene.onReadyChange(handleReady),
    OBR.scene.items.onChange((next) => {
      items = next;
      schedule();
    }),
    OBR.scene.fog.onChange((fog) => {
      fogColor = fog.style.color;
      schedule();
    }),
    OBR.player.onChange((player) => {
      setRole(player.role);
      schedule();
    }),
  ];

  return () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
    OBR.tool.removeAction(getPluginId("player-preview-action"));
    const id = effectId;
    if (id) {
      queue = queue.then(async () => {
        await OBR.scene.local.deleteItems([id]);
      });
    }
    ready = false;
  };
}
