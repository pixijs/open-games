/**
 * The art the race HUD draws, per layout, as three kits that each become one {@link HudAtlas}: `hudArts` lives for the
 * race, `calloutArts` holds every callout banner and chip, and `startArts` the countdown and the controls card (freed
 * after GO).
 */

import { iconButtonSvg, keySvg } from '../art/buttons';
import { boostChevronSvg, gaugeSegmentSvg, minimapFrameSvg, racerDotSvg, speedDialSvg } from '../art/hud';
import { iconSvg } from '../art/icons';
import { confettiSvg, glintSvg } from '../art/motifs';
import { countdownSvg, ordinalSvg, startLightsSvg } from '../art/numerals';
import { calloutSvg, nameTagSvg, panelSvg, toastSvg } from '../art/panels';
import type { SvgArt } from '../art/svg';
import { COLORS, PLACE_METALS, RACERS } from '../art/tokens';
import { stickBaseSvg, stickKnobSvg, touchButtonSvg } from '../art/touch';
import type { HudBox, HudKind } from './layout';
import { hudSpec, mapWidth } from './layout';

type ArtKit = Record<string, SvgArt>;

/** Sizes of the callouts and chips, shared by the kit and the layout */
export interface CalloutSizes {
  readonly bannerW: number;
  /** WRONG WAY's hazard tape, which runs out past the banner's ends */
  readonly tapeW: number;
  readonly bannerH: number;
  readonly bannerY: number;
  readonly ultraW: number;
  readonly ultraH: number;
  readonly upW: number;
  readonly upH: number;
  readonly splitW: number;
  readonly splitH: number;
  readonly finW: number;
  readonly finH: number;
  readonly closeW: number;
  readonly closeH: number;
  readonly backW: number;
  readonly backH: number;
  readonly finishW: number;
  readonly finishH: number;
  readonly launchW: number;
  readonly launchH: number;
  readonly specW: number;
  readonly specH: number;
  readonly arrow: number;
  readonly countdown: number;
  readonly lightsW: number;
  readonly cardW: number;
  readonly cardH: number;
  readonly finishOrdinal: number;
}

export function calloutSizes(box: HudBox): CalloutSizes {
  const d = box.kind === 'desktop';
  const p = box.kind === 'portrait';
  const W = box.width;
  const s = box.safe;
  const touchPause = 56;
  // In landscape the banners and the controls card come level with the mini-map's lower half, so a centred one keeps
  // to twice the room between the middle and the map (the banners leave 16 px more, for WRONG WAY's pulse)
  const mapLeft = W - s.right - mapWidth(hudSpec('landscape').map);
  const landscapeRoom = 2 * (mapLeft - 16 - W / 2);
  const bannerW = d ? 600 : p ? W - 40 : Math.min(460, landscapeRoom);

  return {
    bannerW,
    tapeW: d || p ? Math.min(W + 40, bannerW + 140) : Math.min(bannerW + 140, landscapeRoom),
    bannerH: d ? 100 : p ? 76 : 66,
    bannerY: d ? 190 : p ? 292 : 92,
    ultraW: d ? 300 : 220,
    ultraH: d ? 60 : 46,
    upW: d ? 150 : 104,
    upH: d ? 46 : 36,
    splitW: d ? 230 : 120,
    splitH: d ? 44 : 34,
    finW: d ? 420 : p ? W - s.left - s.right - mapWidth(128) - 12 : 300,
    finH: d ? 52 : 44,
    closeW: d ? 260 : p ? W - s.left - s.right - mapWidth(128) - 12 : 200,
    closeH: d ? 40 : 34,
    backW: d ? 220 : 168,
    backH: d ? 46 : 36,
    finishW: d ? 620 : p ? W - 40 : 340,
    finishH: d ? 120 : p ? 92 : 64,
    launchW: d ? 300 : 210,
    launchH: d ? 52 : 38,
    specW: d ? 340 : p ? W - s.left - s.right - touchPause : 300,
    specH: d ? 56 : 50,
    arrow: d ? 56 : 50,
    countdown: d ? 200 : p ? 144 : 108,
    lightsW: d ? 240 : p ? 130 : 136,
    cardW: d ? 520 : p ? W - 40 : Math.min(470, 2 * (mapLeft - 8 - W / 2)),
    cardH: d ? 236 : p ? 196 : 146,
    finishOrdinal: d ? 130 : p ? 110 : 80,
  };
}

/** Everything the HUD shows for the whole race */
export function hudArts(box: HudBox): ArtKit {
  const spec = hudSpec(box.kind);
  const sizes = calloutSizes(box);
  const kit: ArtKit = {
    plate: panelSvg({ width: spec.plateW, height: spec.plateH, tone: 'hud', chamfer: spec.plateChamfer }),
    pause: iconButtonSvg('pause', { height: spec.pause }),
    pauseDown: iconButtonSvg('pause', { height: spec.pause, state: 'press' }),
    frame: minimapFrameSvg(mapWidth(spec.map), spec.map),
    segOn: gaugeSegmentSvg('on', spec.dial || 110),
    segHot: gaugeSegmentSvg('hot', spec.dial || 110),
    segBoost: gaugeSegmentSvg('boost', spec.dial || 110),
    stick: stickBaseSvg(spec.stick),
    knob: stickKnobSvg(spec.knob),
    knobDown: stickKnobSvg(spec.knob, 'press'),
    cam: touchButtonSvg('camera', { size: spec.camera }),
    camDown: touchButtonSvg('camera', { size: spec.camera, state: 'press' }),
    star: iconSvg('star', { size: 20, metal: 'gold' }),
    spec: toastSvg('info', { width: sizes.specW, height: sizes.specH, icon: 'eye' }),
    back: iconButtonSvg('back', { height: sizes.arrow - 8 }),
    backDown: iconButtonSvg('back', { height: sizes.arrow - 8, state: 'press' }),
    fwd: iconButtonSvg('forward', { height: sizes.arrow - 8 }),
    fwdDown: iconButtonSvg('forward', { height: sizes.arrow - 8, state: 'press' }),
  };

  if (spec.tower) kit.row = panelSvg({ width: 236, height: 30, tone: 'hud', chamfer: 6 });
  if (spec.dial) kit.dial = speedDialSvg(spec.dial);
  else {
    kit.strip = panelSvg({ width: 132, height: 94, tone: 'hud', chamfer: 8 });
    kit.segOff = gaugeSegmentSvg('off', 110);
  }
  for (let place = 1; place <= 4; place++) kit[`ord${place}`] = ordinalSvg(place, { size: spec.ordinal });
  for (let c = 0; c < 4; c++) {
    kit[`you${c}`] = racerDotSvg(RACERS[c], { you: true, size: spec.you });
    kit[`tag${c}`] = nameTagSvg(RACERS[c], { width: spec.tagW, height: spec.tagH });
    for (let place = 1; place <= 4; place++) {
      kit[`dot${c}${place}`] = racerDotSvg(RACERS[c], { size: spec.dot, place });
    }
  }
  kit.chevOff = boostChevronSvg('off', spec.chevron);
  kit.chevOn = boostChevronSvg('charging', spec.chevron);
  kit.chevReady = boostChevronSvg('ready', spec.chevron);

  return kit;
}

/** The callout banners and chips, and the finish's confetti */
export function calloutArts(box: HudBox): ArtKit {
  const s = calloutSizes(box);
  const d = box.kind === 'desktop';
  const kit: ArtKit = {
    final: calloutSvg('final', s.bannerW, s.bannerH),
    wrong: calloutSvg('wrong', s.bannerW, s.bannerH),
    record: calloutSvg('record', s.bannerW, s.bannerH),
    ultra: calloutSvg('boost', s.ultraW, s.ultraH),
    up: calloutSvg('gain', s.upW, s.upH),
    splitGain: calloutSvg('gain', s.splitW, s.splitH),
    splitLoss: calloutSvg('loss', s.splitW, s.splitH),
    fin: calloutSvg('info', s.finW, s.finH),
    closing: calloutSvg('caution', s.closeW, s.closeH),
    backOn: calloutSvg('info', s.backW, s.backH),
    finish: calloutSvg('finish', s.finishW, s.finishH),
    glint: glintSvg(s.bannerH),
    flag: iconSvg('flag', { size: d ? 24 : 20, accent: COLORS.ink900 }),
    respawn: iconSvg('respawn', { size: d ? 24 : 20, accent: COLORS.cyan }),
    sparkle: confettiSvg('star', PLACE_METALS[0].mid, 18),
  };

  for (let c = 0; c < 4; c++) {
    kit[`conf${c}a`] = confettiSvg('strip', RACERS[c].main, 14);
    kit[`conf${c}b`] = confettiSvg('square', RACERS[c].main, 12);
    kit[`conf${c}c`] = confettiSvg('chevron', RACERS[c].main, 14);
  }

  return kit;
}

/** The first-race card's stick drawing, box px */
export function cardStickSize(kind: HudKind): number {
  return kind === 'landscape' ? 60 : 70;
}

/** The start lights, the countdown numerals, the launch chip and the first-race controls card */
export function startArts(box: HudBox): ArtKit {
  const s = calloutSizes(box);
  const cardStick = cardStickSize(box.kind);
  const kit: ArtKit = {
    n3: countdownSvg(3, s.countdown),
    n2: countdownSvg(2, s.countdown),
    n1: countdownSvg(1, s.countdown),
    nGo: countdownSvg('GO', s.countdown),
    lightsGo: startLightsSvg(3, true, s.lightsW),
    launch: calloutSvg('boost', s.launchW, s.launchH),
    card: panelSvg({ width: s.cardW, height: s.cardH, accent: COLORS.cyan, chamfer: 14 }),
    key: keySvg({ width: 40, height: 38 }),
    keyWide: keySvg({ width: 52, height: 38 }),
    cardStick: stickBaseSvg(cardStick),
    cardKnob: stickKnobSvg(cardStick * 0.48),
    cardCam: touchButtonSvg('camera', { size: 40 }),
  };

  for (let lit = 0; lit <= 3; lit++) kit[`lights${lit}`] = startLightsSvg(lit, false, s.lightsW);

  return kit;
}
