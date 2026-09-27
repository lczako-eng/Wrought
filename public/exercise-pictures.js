// public/exercise-pictures.js
// Exercise pictures nobody traced — a line figure moving between two poses.
//
// The founder, looking at ChatGPT drawing pictures in a chat: "Why can't our
// Wrought do this — show you weightlifting techniques... I want it showing
// techniques." What a picture here can honestly show is the MOVEMENT: where the
// bar starts, where it goes, what bends and what stays still. It can never say
// anything about how somebody performs it — WROUGHT cannot see anybody lift —
// so no drawing carries a word, a number, a tick or a cross.
//
// THE RULES THAT MAKE THIS SAFE TO SHIP, each with a test:
//
// - OUR OWN DRAWINGS, FROM JOINT ANGLES. Every pose is a table of angles run
//   through one forward-kinematic rig. Nothing is traced from a photograph or
//   copied from an illustration set, and no SVG file is committed: every
//   picture is produced here, on demand.
// - A NEUTRAL FIGURE. A plain circle for a head, no face, no gender, no muscle.
//   A picture of a body is exactly where a product could start commenting on
//   one, and a stick of uniform width has nothing to comment on.
// - GENERIC KIT. A bench is a line and two legs; a machine is a frame. No brand,
//   no logo, no name — in the drawing or in its label.
// - MOTION WITH A REASON. Two repetitions and then it holds its pose (four
//   alternating iterations that start and stop on the held pose, never
//   `infinite`), and somebody who told their phone that movement makes them
//   ill gets the held pose, still.
// - UNIQUE NAMES. Styles inside an inline SVG are global to the page, so every
//   class starts `wp-` and every keyframe is `wp-<id>-<part>` — the old
//   `@keyframes grow` collision, one feature along.
//
// ONE FILE, THREE READERS. The MCP server imports it for the ids and the
// tables; the dashboard imports it lazily to draw; the chat widget embeds the
// two drawing functions as text. So `wpKin` and `wpSvg` are self-contained —
// they read nothing but their own arguments and Math — because a function
// shipped as a string cannot see this module's other names.
//
// THE RIG. Side view, the figure faces +x. Angles are ABSOLUTE degrees:
// 0 points straight down, 90 forward (+x), 180 up, -90 backward. A pose may
// hold an ANCHOR still (a foot on the floor), solve the arms to a HAND position
// (so a bar travels in a straight line rather than an arc), rest the feet on a
// sloping FLOOR (the treadmill deck), or be drawn from the FRONT (the fly,
// which cannot be seen side-on). Lengths can be foreshortened for a limb that
// points at the viewer.

/** The poses of one picture, keyframe by keyframe. Self-contained. */
export function wpKin(s) {
  const L = { torso: 30, neck: 4, head: 6.5, uarm: 17, farm: 16, thigh: 23, shin: 23, foot: 7 };
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;
  const vec = (a, n) => [Math.sin(rad(a)) * n, Math.cos(rad(a)) * n];
  const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
  const lerp = (a, b, t) => a + (b - a) * t;
  const near = (a, ref) => a + 360 * Math.round((ref - a) / 360);
  const got = (o, k, d) => (o && o[k] != null ? o[k] : d);
  const ROT = ['torso', 'head', 'uarm', 'farm', 'uarm2', 'farm2', 'thigh', 'shin', 'foot', 'thigh2', 'shin2', 'foot2'];
  const LEN = ['lu', 'lu2', 'lt', 'lt2', 'lf', 'lf2'];
  const BASE = { lu: L.uarm, lu2: L.uarm, lt: L.thigh, lt2: L.thigh, lf: L.foot, lf2: L.foot };
  const front = !!s.front;
  const sw = got(s, 'sw', 0), hw = got(s, 'hw', 0);

  // Every angle filled in: the far limbs follow the near ones, the head
  // follows the torso, a foot lies flat, a limb is full length.
  const fill = p => {
    const q = { ...p };
    q.head = got(p, 'head', p.torso);
    q.uarm2 = got(p, 'uarm2', p.uarm); q.farm2 = got(p, 'farm2', p.farm);
    q.thigh2 = got(p, 'thigh2', p.thigh); q.shin2 = got(p, 'shin2', p.shin);
    q.foot = got(p, 'foot', 90); q.foot2 = got(p, 'foot2', q.foot);
    for (const k of LEN) q[k] = got(p, k, k.endsWith('2') ? got(q, k.slice(0, -1), BASE[k]) : BASE[k]);
    return q;
  };

  // A point in the torso's own frame, carried into the world.
  const torsoLocal = (a, x) => { const t = rad(-a); return [x * Math.cos(t), x * Math.sin(t)]; };

  const joints = (p, root) => {
    const hip = root;
    const sh = add(hip, vec(p.torso, L.torso));
    const sh1 = front ? add(sh, torsoLocal(p.torso, -sw)) : sh;
    const sh2 = front ? add(sh, torsoLocal(p.torso, sw)) : sh;
    const el = add(sh1, vec(p.uarm, p.lu)), hand = add(el, vec(p.farm, L.farm));
    const el2 = add(sh2, vec(p.uarm2, p.lu2)), hand2 = add(el2, vec(p.farm2, L.farm));
    const hip1 = front ? add(hip, [hw, 0]) : hip, hip2 = front ? add(hip, [-hw, 0]) : hip;
    const kn = add(hip1, vec(p.thigh, p.lt)), an = add(kn, vec(p.shin, L.shin)), toe = add(an, vec(p.foot, p.lf));
    const kn2 = add(hip2, vec(p.thigh2, p.lt2)), an2 = add(kn2, vec(p.shin2, L.shin)), toe2 = add(an2, vec(p.foot2, p.lf2));
    return { hip, sh, sh1, sh2, el, hand, el2, hand2, kn, an, toe, kn2, an2, toe2 };
  };

  // Two-link arm reaching for a point, the elbow on whichever side is nearer
  // the hinted angle — so a bar can travel in a straight line.
  // AN ELBOW ONLY BENDS ONE WAY. Near a straight arm the two solutions sit a
  // few degrees apart and the hint can be nearer the one that bends it
  // backwards — a bench lockout drawn hyperextended, on the still tile. So
  // when the arm is nearly straight, the solution whose forearm is flexed
  // FORWARD of the upper arm wins, and only then the one nearer the hint.
  // Not when the arm is well bent: the squat's hand folds up behind the bar,
  // and "forward" there would throw its elbow over its head.
  const reach = (from, target, lu, hintU, hintF) => {
    const dx = target[0] - from[0], dy = target[1] - from[1];
    const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(lu - L.farm) + 0.01), lu + L.farm - 0.001);
    const phi = deg(Math.atan2(dx, dy));
    const al = deg(Math.acos(Math.max(-1, Math.min(1, (lu * lu + d * d - L.farm * L.farm) / (2 * lu * d)))));
    const c1 = near(phi + al, hintU), c2 = near(phi - al, hintU);
    const flex = c => { const e = add(from, vec(c, lu)); return ((deg(Math.atan2(target[0] - e[0], target[1] - e[1])) - c) % 360 + 540) % 360 - 180; };
    const f1 = flex(c1) >= -0.5, f2 = flex(c2) >= -0.5;
    const u = al < 25 && f1 !== f2 ? (f1 ? c1 : c2) : (Math.abs(c1 - hintU) <= Math.abs(c2 - hintU) ? c1 : c2);
    const el = add(from, vec(u, lu));
    return [u, near(deg(Math.atan2(target[0] - el[0], target[1] - el[1])), hintF)];
  };

  const rootFor = p => {
    const at = s.at || [60, 60];
    if (s.anchor) {
      const j = joints(p, [0, 0])[s.anchor];
      return [at[0] - j[0], at[1] - j[1]];
    }
    if (s.floor) {
      // Feet rest on a (possibly sloping) line: the lowest point of either
      // foot sits `gap` above it, so a walking figure bobs as it would.
      const [x0, y0, x1, y1, gap] = s.floor;
      const j = joints(p, at);
      let worst = -Infinity;
      for (const k of ['an', 'toe', 'an2', 'toe2']) {
        const q = j[k];
        worst = Math.max(worst, q[1] - (y0 + (y1 - y0) * (q[0] - x0) / (x1 - x0)));
      }
      return [at[0], at[1] - gap - worst];
    }
    return s.at || [60, 60];
  };

  // A hand given as an offset from the shoulder (`hand`), or as a point in
  // the drawing (`grip`), is solved for its arm.
  const place = p => {
    const q = fill(p);
    const j = joints(q, rootFor(q));
    const target = p.grip || (p.hand ? add(j.sh1, p.hand) : null);
    if (target) [q.uarm, q.farm] = reach(j.sh1, target, q.lu, q.uarm, q.farm);
    if (p.hand2) [q.uarm2, q.farm2] = reach(j.sh2, add(j.sh2, p.hand2), q.lu2, q.uarm2, q.farm2);
    else if (target && s.a.uarm2 == null) { q.uarm2 = q.uarm; q.farm2 = q.farm; }
    return q;
  };

  const A = place(s.a);
  let B;
  if (s.carry) {
    // The hands ride on something the torso carries (a bar across the back),
    // so the arms turn with the torso and keep their grip.
    const d = got(s.b, 'torso', s.a.torso) - s.a.torso;
    const bb = { ...s.a, ...s.b };
    delete bb.hand; delete bb.grip; delete bb.hand2;
    for (const key of ['uarm', 'farm', 'uarm2', 'farm2']) bb[key] = A[key] + d;
    B = fill(bb);
  } else {
    const bm = { ...s.a, ...s.b };
    if (s.b.hand) delete bm.grip;
    if (s.b.grip) delete bm.hand;
    B = place(bm);
  }
  const steps = s.steps || 6;
  const rootA = rootFor(A), rootB = rootFor(B);
  const jA = joints(A, rootA), jB = joints(B, rootB);

  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = {};
    for (const k of ROT.concat(LEN)) p[k] = lerp(A[k], B[k], t);
    if (s.ik) {
      // The hand travels in a straight line in the world; the arm follows.
      const shNow = joints(p, rootFor(p));
      [p.uarm, p.farm] = reach(shNow.sh1, [lerp(jA.hand[0], jB.hand[0], t), lerp(jA.hand[1], jB.hand[1], t)], p.lu, p.uarm, p.farm);
      [p.uarm2, p.farm2] = s.ik === 'both'
        ? reach(shNow.sh2, [lerp(jA.hand2[0], jB.hand2[0], t), lerp(jA.hand2[1], jB.hand2[1], t)], p.lu2, p.uarm2, p.farm2)
        : (s.a.uarm2 == null && !s.a.hand2 ? [p.uarm, p.farm] : [p.uarm2, p.farm2]);
    }
    const root = rootFor(p);
    const r = {
      torso: -p.torso, head: -(p.head - p.torso),
      uarm: -(p.uarm - p.torso), farm: -(p.farm - p.uarm),
      uarm2: -(p.uarm2 - p.torso), farm2: -(p.farm2 - p.uarm2),
      thigh: -p.thigh, shin: -(p.shin - p.thigh), foot: -(p.foot - p.shin),
      thigh2: -p.thigh2, shin2: -(p.shin2 - p.thigh2), foot2: -(p.foot2 - p.shin2),
    };
    const j = joints(p, root);
    let tether = null;
    if (s.tether) {
      const dx = j.hand[0] - s.tether[0], dy = j.hand[1] - s.tether[1];
      tether = [deg(Math.atan2(dy, dx)), Math.hypot(dx, dy)];
    }
    frames.push({ t, p, root, r, j, tether });
  }
  // Keep a tether's angle continuous, or CSS turns it the long way round.
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].tether) frames[i].tether[0] = near(frames[i].tether[0], frames[i - 1].tether[0]);
  }
  return { L, ROT, LEN, BASE, frames, joints, front, sw, hw };
}

/** One picture as an SVG string. Self-contained apart from wpKin. */
export function wpSvg(s, id, still) {
  const k = wpKin(s);
  const { L, frames } = k;
  const f0 = frames[0];
  // THE HELD POSE. Most pictures hold the start of the rep; one whose start
  // is a person standing upright (the hinge, the squat, the press) holds the
  // other end instead, or three still tiles in a list read as one. The
  // repetitions run the other way round so they still start and stop on it.
  const back = s.hold === 'b';
  const WP_REPS = 4;
  const fh = back ? frames[frames.length - 1] : f0;
  const c = `wp-${id}`;
  const r1 = n => Math.round(n * 10) / 10;
  const r3 = n => Math.round(n * 1000) / 1000;
  const pct = t => `${r1(t * 100)}%`;
  const moved = (get, eps) => frames.some(f => Math.abs(get(f) - get(f0)) > eps);

  const rotParts = k.ROT.filter(part => moved(f => f.r[part], 0.05));
  const lenParts = k.LEN.filter(part => moved(f => f.p[part], 0.05));
  const rootMoves = moved(f => f.root[0], 0.05) || moved(f => f.root[1], 0.05);
  const tetherMoves = !!s.tether && (moved(f => f.tether[0], 0.05) || moved(f => f.tether[1], 0.05));

  const scaleOf = (part, f) => `scale(1,${r3(f.p[part] / k.BASE[part])})`;
  const shiftOf = (part, f) => `translate(0px,${r1(f.p[part])}px)`;
  const tetherOf = f => `rotate(${r1(f.tether[0])}deg) scale(${r1(f.tether[1])},1)`;
  const kf = (name, fn) => `@keyframes ${c}-${name}{${frames.map(f => `${pct(f.t)}{transform:${fn(f)}}`).join('')}}`;
  // Scoped to a PLAYING copy. Styles inside an inline SVG are global to the
  // page, so an unscoped rule written by one moving figure animated every
  // still tile of the same movement — tap one bench and every bench moved.
  const run = (sel, name) => `.${c}.wp-play .wp-${sel}{animation:${c}-${name} ${s.dur || 2.4}s cubic-bezier(.45,0,.55,1) ${WP_REPS} ${back ? 'alternate-reverse' : 'alternate'} both}`;

  const css = [
    `.${c} *{transform-box:view-box;transform-origin:0 0}`,
    `.${c} .wp-s{fill:none;stroke:currentColor;stroke-width:6.2;stroke-linecap:round;stroke-linejoin:round}`,
    `.${c} .wp-n{fill:currentColor}`,
    `.${c} .wp-f{opacity:.42}`,
    `.${c} .wp-k{fill:none;stroke:var(--wp-kit,#7A6E67);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}`,
    `.${c} .wp-kf{fill:var(--wp-kit,#7A6E67)}`,
    `.${c} .wp-h{fill:var(--wp-heat,#F26419)}`,
    `.${c} .wp-hs{fill:none;stroke:var(--wp-heat,#F26419);stroke-width:3.4;stroke-linecap:round}`,
    `.${c} .wp-t{fill:none;stroke:var(--wp-kit,#7A6E67);stroke-width:1.4}`,
    `.${c} .wp-o{fill:var(--wp-bg,#14110F)}`,
    `.${c} .wp-g{fill:none;stroke:var(--wp-floor,#332B27);stroke-width:2}`,
  ];
  if (!still) {
    for (const part of rotParts) css.push(kf(part, f => `rotate(${r1(f.r[part])}deg)`), run(part, part));
    for (const part of lenParts) {
      css.push(kf(part, f => scaleOf(part, f)), run(part, part));
      if (!part.startsWith('lf')) css.push(kf(`${part}e`, f => shiftOf(part, f)), run(`${part}e`, `${part}e`));
    }
    if (rootMoves) css.push(kf('root', f => `translate(${r1(f.root[0])}px,${r1(f.root[1])}px)`), run('root', 'root'));
    if (tetherMoves) css.push(kf('tet', tetherOf), run('tet', 'tet'));
  }
  // Told the phone that movement makes them ill: the held pose, still.
  // Not slower — none.
  css.push(`@media (prefers-reduced-motion:reduce){.${c} *{animation:none!important}}`);

  const P = s.props || {};
  const rot = part => `style="transform:rotate(${r1(fh.r[part])}deg)"`;
  const lenStyle = part => (Math.abs(fh.p[part] - k.BASE[part]) > 0.05 || lenParts.includes(part) ? ` style="transform:${scaleOf(part, fh)}"` : '');
  const seg = (base, far, lenPart) =>
    `<path class="wp-s${far ? ' wp-f' : ''}${lenPart ? ` wp-${lenPart}` : ''}" d="M0 0v${base}"${lenPart ? lenStyle(lenPart) : ''}/>`;
  const lenOr = (part, fallback) => (part ? fh.p[part] : fallback);
  const joint = (part, len) => (part && lenParts.includes(part)
    ? `<g class="wp-${part}e" style="transform:${shiftOf(part, fh)}">`
    : `<g transform="translate(0 ${r1(len)})">`);

  const side = k.front ? 0 : 1;
  const arm = (n, far) => {
    const lu = `lu${n}`;
    const hand = n ? P.hand2 : P.hand;
    const along = n ? P.farm2 : P.farm;
    return `<g class="wp-uarm${n}" ${rot(`uarm${n}`)}>${seg(L.uarm, far, lu)}${joint(lu, lenOr(lu, L.uarm))}` +
      `<g class="wp-farm${n}" ${rot(`farm${n}`)}>${seg(L.farm, far)}${along || ''}<g transform="translate(0 ${L.farm})">${hand || ''}</g></g></g></g>`;
  };
  const leg = (n, far) => {
    const lt = `lt${n}`, lf = `lf${n}`;
    return `<g class="wp-thigh${n}" ${rot(`thigh${n}`)}>${seg(L.thigh, far, lt)}${joint(lt, lenOr(lt, L.thigh))}` +
      `<g class="wp-shin${n}" ${rot(`shin${n}`)}>${seg(L.shin, far)}<g transform="translate(0 ${L.shin})">` +
      `<g class="wp-foot${n}" ${rot(`foot${n}`)}>${seg(L.foot, far, lf)}</g></g></g></g></g>`;
  };
  // Front view: shoulders and hips have width, both sides are near.
  const at = (x, inner) => (k.front ? `<g transform="translate(${x} 0)">${inner}</g>` : inner);
  const body =
    `<g class="wp-root" style="transform:translate(${r1(fh.root[0])}px,${r1(fh.root[1])}px)">` +
      at(-k.hw, leg('2', side)) +
      `<g class="wp-torso" ${rot('torso')}>${seg(L.torso)}<g transform="translate(0 ${L.torso})">` +
        (k.front ? `<path class="wp-s" d="M${-k.sw} 0H${k.sw}"/>` : '') +
        at(k.sw, arm('2', side)) +
        `<g class="wp-head" ${rot('head')}><circle class="wp-n" cx="0" cy="${L.neck + L.head}" r="${L.head}"/></g>` +
        (P.shoulder || '') +
        at(-k.sw, arm('', false)) +
      `</g></g>` +
      at(k.hw, leg('', false)) +
      (k.front ? `<path class="wp-s" d="M${-k.hw} 0H${k.hw}"/>` : '') +
    `</g>`;
  const tether = s.tether
    ? `<g transform="translate(${s.tether[0]} ${s.tether[1]})"><path class="wp-t wp-tet" d="M0 0h1" style="transform:${tetherOf(fh)}"/></g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.view || '0 0 120 120'}" class="${c}${still ? '' : ' wp-play'}" role="img" aria-label="${s.label}">` +
    `<title>${s.label}</title><style>${css.join('')}</style>${s.world || ''}${tether}${body}${s.over || ''}</svg>`;
}

// ── Kit, drawn once, carrying no numbers of any kind ───────────────────────
// A barbell seen end-on is a plate; a dumbbell or a handle is a short bar.
const plate = r => `<circle class="wp-h" r="${r}"/><circle class="wp-o" r="${Math.round(r * 2.8) / 10}"/>`;
const grip = w => `<path class="wp-hs" d="M${-w / 2} 0h${w}"/>`;
const floor = 'M6 111h108';

// ── The pictures ────────────────────────────────────────────────────────────
// `a` is the start pose and `b` the other end of one repetition; a picture
// holds on `a` unless it says `hold: 'b'`. `hand` is where the hand is relative to the shoulder, when a bar
// has to be somewhere particular; `ik` keeps the bar on a straight line.
export const PICTURES = {
  bench: {
    label: 'Bench press', view: '18 34 80 80',
    // Lying on the back, head to the left, feet on the floor. The bar comes
    // down over the lower chest and goes back up over the shoulders.
    a: { torso: -90, head: -90, thigh: 86, shin: -22, foot: 90, uarm: 180, farm: 180, hand: [2, -32.5] },
    b: { uarm: 55, farm: 185, hand: [11, -8.5] },
    ik: 1, at: [70, 84.5], steps: 6,
    props: { hand: plate(8.5) },
    world: `<path class="wp-k" d="M28 90H73M34 90v19M68 90v19"/><path class="wp-g" d="${floor}"/>`,
  },
  'bench-incline': {
    label: 'Incline bench press', view: '9 20 94 94',
    // Lying back on a bench set at an angle; the bar travels straight up
    // from the upper chest.
    a: { torso: -126, head: -126, thigh: 78, shin: -12, foot: 90, uarm: 180, farm: 180, hand: [1, -32.5] },
    b: { uarm: 60, farm: 190, hand: [7.8, -2.4] },
    ik: 1, at: [62, 80], steps: 6,
    props: { hand: plate(8.5) },
    world: `<path class="wp-k" d="M59.6 84L24 58M59.6 84H74M66 84v25M34 66l-8 43"/><path class="wp-g" d="${floor}"/>`,
  },
  'row-bent': {
    label: 'Bent-over row', view: '16 30 84 84',
    // Hinged forward with soft knees; the bar hangs below the shoulders and is
    // pulled to the lower ribs while the torso stays where it started.
    // The bar hangs over the feet — from the toes to the heel as it comes in —
    // or a lifter drawn like this would tip forward.
    a: { torso: 132, head: 136, thigh: 52, shin: -8, foot: 90, uarm: 2, farm: 2, hand: [0.5, 32.8] },
    b: { uarm: -80, farm: 40, hand: [-6.5, 12] },
    ik: 1, anchor: 'an', at: [50, 107], steps: 6,
    props: { hand: plate(8.5) },
    world: `<path class="wp-g" d="${floor}"/>`,
  },
  'row-seated': {
    label: 'Seated row', view: '10 32 82 82',
    // Sitting tall, feet braced on the plate, a handle pulled in to the belly
    // along the line of the cable.
    a: { torso: 170, head: 172, thigh: 108, shin: 72, foot: 170, uarm: 70, farm: 70, hand: [31, 12] },
    b: { torso: 180, head: 180, uarm: -30, farm: 90, hand: [8, 14] },
    ik: 1, at: [26, 93.5], steps: 6, tether: [84, 77],
    props: { hand: grip(7) },
    world: `<path class="wp-k" d="M12 97.5H42M27 97.5V110M75 97l-2-16M86 111V40M80 40h10"/><circle class="wp-kf" cx="84" cy="77" r="2.4"/><path class="wp-g" d="${floor}"/>`,
  },
  'fly-machine': {
    label: 'Machine chest fly', view: '14 22 92 92',
    // Seen from the front, because a fly cannot be seen side-on: seated, the
    // forearms on the pads, the pads brought together in front of the chest.
    front: true, sw: 8, hw: 5,
    a: { torso: 180, thigh: 0, shin: 0, foot: 90, foot2: -90, lt: 5, lf: 3, uarm: 90, farm: 180, uarm2: -90, farm2: 180, lu: 17 },
    b: { lu: -6.5 },
    at: [60, 79], steps: 6,
    props: { farm: '<rect class="wp-h" x="-3.4" y="1" width="6.8" height="14" rx="2.4"/>', farm2: '<rect class="wp-h" x="-3.4" y="1" width="6.8" height="14" rx="2.4"/>' },
    world: `<path class="wp-k" d="M52 30h16v52H52zM44 84h32M60 84v25M18 111V24h84v87"/><path class="wp-g" d="${floor}"/>`,
  },
  'press-standing': {
    label: 'Overhead press', view: '-1 -13 126 126',
    // Standing tall; the bar goes from the front of the shoulders to straight
    // overhead, in a straight line.
    a: { torso: 180, head: 180, thigh: 0, shin: 0, foot: 90, uarm: 28, farm: 180, hand: [8, -1] },
    b: { uarm: 178, farm: 180, hand: [1.5, -32.8] },
    ik: 1, anchor: 'an', at: [56, 107], steps: 6, hold: 'b',
    props: { hand: plate(8.5) },
    world: `<path class="wp-g" d="${floor}"/>`,
  },
  'press-machine': {
    label: 'Machine shoulder press', view: '10 14 100 100',
    // Seated against a back pad; the handles go from shoulder height to
    // overhead.
    a: { torso: 186, head: 184, thigh: 90, shin: -4, foot: 90, uarm: 25, farm: 180, hand: [6, -1] },
    b: { uarm: 170, farm: 178, hand: [7, -32.2] },
    ik: 1, at: [50, 86], steps: 6,
    props: { hand: grip(7) },
    world: `<path class="wp-k" d="M44 90.5H70M56 90.5V110M43 88l-5-42M38 111V20M38 20h22"/><path class="wp-g" d="${floor}"/>`,
  },
  rdl: {
    label: 'Romanian deadlift', view: '20 14 100 100',
    // Standing tall with the bar at the hips, then the hips push back, the
    // knees stay soft and the bar slides down the legs to about the knee.
    a: { torso: 180, head: 180, thigh: 0, shin: 0, foot: 90, uarm: 6, farm: 6, grip: [59.5, 63.5] },
    b: { torso: 104, head: 110, thigh: 24, shin: -6, uarm: -20, farm: -20, grip: [63, 86] },
    ik: 1, anchor: 'an', at: [56, 107], steps: 6, hold: 'b',
    props: { hand: plate(8.5) },
    world: `<path class="wp-g" d="${floor}"/>`,
  },
  treadmill: {
    label: 'Incline treadmill walk', view: '3 1 112 112',
    // Walking up a sloped deck, arms swinging opposite the legs, hands off
    // the rails. Two strides and it stands still.
    a: { torso: 176, head: 178, thigh: 24, shin: 2, foot: 100, thigh2: -20, shin2: -34, foot2: 70,
      uarm: -22, farm: -5, uarm2: 24, farm2: 60 },
    b: { thigh: -20, shin: -34, foot: 70, thigh2: 24, shin2: 2, foot2: 100,
      uarm: 24, farm: 60, uarm2: -22, farm2: -5 },
    floor: [12, 107, 104, 92, 4.6], at: [52, 52], steps: 6, dur: 1.1,
    world: `<path class="wp-k" d="M12 107L104 92M104 92L99 46M92 45h12M100 63l-26 4"/><path class="wp-k" d="M14 107v4M100 93v18"/><path class="wp-g" d="${floor}"/>`,
  },
  'squat-barbell': {
    label: 'Back squat', view: '7 14 100 100',
    // The bar across the upper back; hips back and down, knees forward, the
    // bar staying over the middle of the foot.
    // The elbows point down and back, the hands on the bar behind the neck.
    a: { torso: 180, head: 180, thigh: 0, shin: 0, foot: 90, uarm: -45, farm: 150, hand: [-4, -2] },
    b: { torso: 148, head: 152, thigh: 92, shin: -34 },
    carry: true, anchor: 'an', at: [56, 107], steps: 8, hold: 'b',
    props: { shoulder: `<g transform="translate(4 2)">${plate(8.5)}</g>` },
    world: `<path class="wp-g" d="${floor}"/>`,
  },
  pulldown: {
    label: 'Lat pulldown', view: '0 6 108 108',
    // Seated with the thighs under the pad; the bar is pulled from overhead
    // down to the upper chest, leaning back a little.
    a: { torso: 181, head: 181, thigh: 92, shin: -2, foot: 90, uarm: 176, farm: 180, hand: [4, -32] },
    b: { torso: 194, head: 188, uarm: -12, farm: 168, hand: [7.2, 3.1] },
    ik: 1, at: [48, 88], steps: 6, tether: [62, 12],
    props: { hand: grip(12) },
    world: `<path class="wp-k" d="M36 92.5H62M48 92.5V110M66 80h8M26 111V8h46M62 8v4"/><path class="wp-g" d="${floor}"/>`,
  },
};

export const PICTURE_IDS = Object.keys(PICTURES);

/** How long a moving picture runs before it holds, in milliseconds. */
export function pictureRunMs(id) {
  const s = PICTURES[id];
  return s ? Math.round((s.dur || 2.4) * 4 * 1000) : 0;
}

// Resolved by the lookup, not yet drawn. pictureFor never returns one of
// these, so a movement waiting for its picture shows none rather than the
// nearest wrong one.
export const PICTURES_PENDING = [
  'squat-front', 'squat-goblet', 'leg-press', 'deadlift', 'hip-thrust', 'kb-swing',
  'bench-dumbbell', 'press-up', 'dip', 'press-seated', 'row-dumbbell', 'row-inverted',
  'pull-up', 'lunge', 'split-squat', 'step-up', 'carry', 'plank', 'knee-raise', 'ab-wheel', 'rower',
];

/** The drawing for an id, or null. Takes no label: a picture says what it is. */
export function pictureSvg(id, { still = false } = {}) {
  if (!PICTURE_IDS.includes(id)) return null;
  return wpSvg(PICTURES[id], id, still);
}

/**
 * How far the anchored point wanders between keyframes, in drawing units.
 * CSS interpolates each joint's rotation in a straight line between two
 * keyframes, which bends the path of a foot that should be planted; enough
 * keyframes keep that under half a unit. Floor-rested pictures measure the
 * gap to the floor instead.
 */
export function anchorDrift(id) {
  const s = PICTURES[id];
  if (!s || (!s.anchor && !s.floor)) return 0;
  const k = wpKin(s);
  const fr = k.frames;
  let worst = 0;
  for (let i = 0; i + 1 < fr.length; i++) {
    for (let u = 0; u <= 1.0001; u += 0.1) {
      const p = {};
      for (const key of k.ROT.concat(k.LEN)) p[key] = fr[i].p[key] + (fr[i + 1].p[key] - fr[i].p[key]) * u;
      const root = [fr[i].root[0] + (fr[i + 1].root[0] - fr[i].root[0]) * u, fr[i].root[1] + (fr[i + 1].root[1] - fr[i].root[1]) * u];
      const j = k.joints(p, root);
      if (s.anchor) {
        const target = k.joints(fr[0].p, fr[0].root)[s.anchor];
        worst = Math.max(worst, Math.hypot(j[s.anchor][0] - target[0], j[s.anchor][1] - target[1]));
      } else {
        const [x0, y0, x1, y1, gap] = s.floor;
        let low = -Infinity;
        for (const key of ['an', 'toe', 'an2', 'toe2']) {
          const q = j[key];
          low = Math.max(low, q[1] - (y0 + (y1 - y0) * (q[0] - x0) / (x1 - x0)));
        }
        worst = Math.max(worst, Math.abs(low + gap));
      }
    }
  }
  return Math.round(worst * 100) / 100;
}

// What the chat widget embeds as text, in this order. Both are self-contained.
export const PICTURE_RUNTIME = [wpKin, wpSvg];
