/**
 * Shader snippets the weather bits share: a loop that lights a point from the view's own light list, and a
 * velocity-stretched quad that collapses to a round bead when the motion it shows gets short.
 *
 * Both read only engine globals and locals the calling bit declares, so every bit inlines them in its own slot.
 */

import { MAX_LIGHTS } from '@pixi/3d';

/**
 * How much a directional light (the moon, a lightning flash) adds to a drop, against a point or spot light. They
 * reach every drop on screen at once, so they stay a faint wash.
 */
const DIRECTIONAL_WEIGHT = '0.2';

/** Widest a bead is drawn on screen, in pixels, so the drops nearest the lens stay glass beads, not snowflakes. */
const BEAD_PIXELS = 5;

/**
 * A number as a float literal both shading languages accept; GLSL rejects `1` where it wants a float.
 * @param value - The number.
 * @returns The literal.
 */
export function lit(value: number): string {
  return value.toFixed(4);
}

/**
 * Adds the view's lights at a point into a `vec3` local. The engine packs every light the frame shades into
 * `uLightData` (4 vec4 each) and its count into `uGlobalLightParams.w`, so the weather picks up the floodlights,
 * headlights and flashes with no wiring at all.
 *
 * Softer at the edges than the PBR lighting: a beam seen through rain has no surface to end on, so the range fades
 * out over its last three quarters and a spot's cone always fades over at least the inner half of its width,
 * whatever its penumbra.
 * @param gpu - `true` for WGSL, `false` for GLSL.
 * @param at - A `vec3` expression, the lit point in world space.
 * @param out - The `vec3` local the light is added into.
 * @param phase - How much light leaves toward the camera: an expression of `wxToL`, the unit vector from the
 *   point to the light.
 * @returns The snippet, wrapped in its own block.
 */
export function lightLoop(gpu: boolean, at: string, out: string, phase: string): string {
  if (gpu) {
    return /* wgsl */ `
  {
    let wxAt = ${at};
    let wxCount = i32(global.uGlobalLightParams.w);

    for (var wxI: i32 = 0; wxI < ${MAX_LIGHTS}; wxI++) {
      if (wxI >= wxCount) { break; }

      let wxL0 = global.uLightData[wxI * 4];
      let wxL1 = global.uLightData[wxI * 4 + 1];
      let wxL2 = global.uLightData[wxI * 4 + 2];
      var wxToL = -wxL2.xyz;
      var wxAtt = ${DIRECTIONAL_WEIGHT};

      if (wxL0.w > 0.5) {
        let wxD = wxL0.xyz - wxAt;
        let wxD2 = dot(wxD, wxD);
        let wxR2 = wxL1.w * wxL1.w;

        if (wxL1.w > 0.0 && wxD2 >= wxR2) { continue; }

        let wxWin = select(1.0, 1.0 - smoothstep(0.25, 1.0, sqrt(wxD2 / max(wxR2, 1e-4))), wxL1.w > 0.0);

        wxAtt = wxWin * wxWin / max(wxD2, 0.05);
        wxToL = wxD * inverseSqrt(max(wxD2, 1e-6));

        if (wxL0.w > 1.5) {
          let wxInner = max(global.uLightData[wxI * 4 + 3].x, wxL2.w + 0.5 * (1.0 - wxL2.w));

          wxAtt *= smoothstep(wxL2.w, wxInner, dot(-wxToL, wxL2.xyz));
        }
      }

      ${out} += wxL1.xyz * (wxAtt * (${phase}));
    }
  }
`;
  }

  return /* glsl */ `
  {
    vec3 wxAt = ${at};
    int wxCount = int(uGlobalLightParams.w);

    for (int wxI = 0; wxI < ${MAX_LIGHTS}; wxI++) {
      if (wxI >= wxCount) break;

      vec4 wxL0 = uLightData[wxI * 4];
      vec4 wxL1 = uLightData[wxI * 4 + 1];
      vec4 wxL2 = uLightData[wxI * 4 + 2];
      vec3 wxToL = -wxL2.xyz;
      float wxAtt = ${DIRECTIONAL_WEIGHT};

      if (wxL0.w > 0.5) {
        vec3 wxD = wxL0.xyz - wxAt;
        float wxD2 = dot(wxD, wxD);
        float wxR2 = wxL1.w * wxL1.w;

        if (wxL1.w > 0.0 && wxD2 >= wxR2) continue;

        float wxWin = wxL1.w > 0.0 ? 1.0 - smoothstep(0.25, 1.0, sqrt(wxD2 / max(wxR2, 1e-4))) : 1.0;

        wxAtt = wxWin * wxWin / max(wxD2, 0.05);
        wxToL = wxD * inversesqrt(max(wxD2, 1e-6));

        if (wxL0.w > 1.5) {
          float wxInner = max(uLightData[wxI * 4 + 3].x, wxL2.w + 0.5 * (1.0 - wxL2.w));

          wxAtt *= smoothstep(wxL2.w, wxInner, dot(-wxToL, wxL2.xyz));
        }
      }

      ${out} += wxL1.xyz * (wxAtt * (${phase}));
    }
  }
`;
}

/**
 * Compresses bright light on a drop without flattening it: it grows as a square root past 1, so a drop right in front
 * of a lamp glows rather than clips, and the falloff of a beam stays visible all the way to its edge.
 * @param gpu - `true` for WGSL, `false` for GLSL.
 * @param v - The `vec3` local to compress, in place.
 * @returns The snippet.
 */
export function softKnee(gpu: boolean, v: string): string {
  const rsqrt = gpu ? 'inverseSqrt' : 'inversesqrt';

  return `${v} *= ${rsqrt}(1.0 + max(max(${v}.r, ${v}.g), ${v}.b));`;
}

/**
 * Builds a camera-facing quad stretched along a drop's motion over the shutter, replacing the particle bit's
 * billboard. Runs in `afterTransform`, inside a block that declares:
 *
 * - `sMid` (vec3): the middle of the streak in world space
 * - `sVel` (vec3): the drop's world velocity
 * - `sShutter` (f32): the shutter in world seconds, so slow motion shortens the streak
 * - `sBead` (f32): the drop's diameter when it hangs still
 * - `sWidth` (f32): the streak's width at full length
 * - `sCam` (vec3): the camera position
 * - `sPx` (f32): world size of one pixel at unit distance
 *
 * It declares `wxDist` and `wxView` (camera to streak), `wxThin` (opacity left after widening a sub-pixel streak to
 * a pixel), `wxEnergy` (a long streak spreads the same light over more pixels, so a bead shines brighter per pixel
 * than a streak) and `wxBeadness` (1 once the streak has shrunk to a round drop), and writes the `vStreak` varying
 * {@link streakFragment} shapes.
 * @param gpu - `true` for WGSL, `false` for GLSL.
 * @returns The snippet; it does not open a block.
 */
export function streakVertex(gpu: boolean): string {
  if (gpu) {
    return /* wgsl */ `
    let wxToMid = sMid - sCam;
    let wxDist = length(wxToMid);
    let wxView = wxToMid / max(wxDist, 1e-4);
    let wxSpeed = length(sVel);
    let wxAxis = sVel / max(wxSpeed, 1e-5);
    // The motion as the camera sees it: the axis flattened onto the plane facing the camera.
    let wxAxisP = wxAxis - wxView * dot(wxAxis, wxView);
    let wxSin = length(wxAxisP);
    let wxAlong = select(billboardUp, wxAxisP / max(wxSin, 1e-5), wxSin > 1e-3);
    let wxSide = normalize(cross(wxAlong, wxView));
    let wxLen = wxSpeed * sShutter * wxSin;
    // A streak stays a hairline however close; a bead stays a fine bead, between a couple of pixels and a few.
    let wxRound = 1.0 - smoothstep(0.0, 4.0 * sBead, wxLen);
    let wxW0 = mix(min(sWidth, wxDist * sPx * 2.2), min(sBead, wxDist * sPx * ${lit(BEAD_PIXELS)}), wxRound);
    let wxW = max(wxW0, wxDist * sPx * mix(1.0, 1.8, wxRound));
    let wxThin = wxW0 / wxW;
    let wxEnergy = pow(sBead / (wxLen + sBead), 0.45);
    let wxBeadness = 1.0 - smoothstep(0.4, 2.0, wxLen / wxW);

    worldPosition = vec4<f32>(
      sMid + wxAlong * (particleCorner.y * (wxLen + wxW)) + wxSide * (particleCorner.x * wxW),
      1.0
    );
    clipPosition = camera.uViewProjectionMatrix * worldPosition;
    output.vStreak = vec4<f32>(
      particleCorner.x,
      particleCorner.y * (wxLen + wxW) / wxW,
      0.5 * wxLen / wxW,
      wxBeadness
    );
`;
  }

  return /* glsl */ `
    vec3 wxToMid = sMid - sCam;
    float wxDist = length(wxToMid);
    vec3 wxView = wxToMid / max(wxDist, 1e-4);
    float wxSpeed = length(sVel);
    vec3 wxAxis = sVel / max(wxSpeed, 1e-5);
    // The motion as the camera sees it: the axis flattened onto the plane facing the camera.
    vec3 wxAxisP = wxAxis - wxView * dot(wxAxis, wxView);
    float wxSin = length(wxAxisP);
    vec3 wxAlong = wxSin > 1e-3 ? wxAxisP / wxSin : billboardUp;
    vec3 wxSide = normalize(cross(wxAlong, wxView));
    float wxLen = wxSpeed * sShutter * wxSin;
    // A streak stays a hairline however close; a bead stays a fine bead, between a couple of pixels and a few.
    float wxRound = 1.0 - smoothstep(0.0, 4.0 * sBead, wxLen);
    float wxW0 = mix(min(sWidth, wxDist * sPx * 2.2), min(sBead, wxDist * sPx * ${lit(BEAD_PIXELS)}), wxRound);
    float wxW = max(wxW0, wxDist * sPx * mix(1.0, 1.8, wxRound));
    float wxThin = wxW0 / wxW;
    float wxEnergy = pow(sBead / (wxLen + sBead), 0.45);
    float wxBeadness = 1.0 - smoothstep(0.4, 2.0, wxLen / wxW);

    worldPosition = vec4(sMid + wxAlong * (particleCorner.y * (wxLen + wxW)) + wxSide * (particleCorner.x * wxW), 1.0);
    gl_Position = uProjectionMatrix * uViewMatrix * worldPosition;
    vStreak = vec4(
      particleCorner.x,
      particleCorner.y * (wxLen + wxW) / wxW,
      0.5 * wxLen / wxW,
      wxBeadness
    );
`;
}

/**
 * Shapes the quad {@link streakVertex} built: a soft capsule along a streak, and as it shortens into a bead, a
 * glassy drop with a bright rim and a glint. `vStreak` is (across, along, half the segment, beadness), lengths in
 * widths.
 * @param gpu - `true` for WGSL, `false` for GLSL.
 * @returns The fragment `material` snippet.
 */
export function streakFragment(gpu: boolean): string {
  const v = gpu ? 'input.vStreak' : 'vStreak';
  const decl = gpu ? 'let' : 'float';
  const vec2 = gpu ? 'vec2<f32>' : 'vec2';

  return `
  {
    ${decl} wxDy = max(abs(${v}.y) - ${v}.z, 0.0);
    ${decl} wxD = length(${vec2}(${v}.x, wxDy)) * 2.0;
    ${decl} wxCore = 1.0 - smoothstep(0.3, 1.0, wxD);
    ${decl} wxRim = smoothstep(0.45, 0.8, wxD) * (1.0 - smoothstep(0.8, 1.0, wxD));
    ${decl} wxGlint = 1.0 - smoothstep(0.0, 0.34, length(${vec2}(${v}.x + 0.17, ${v}.y - 0.17)) * 2.0);

    alpha *= mix(wxCore, 0.3 * wxCore + 0.9 * wxRim + 1.5 * wxGlint, ${v}.w);
  }
`;
}
