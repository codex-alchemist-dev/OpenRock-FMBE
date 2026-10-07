// The formula engine for animated groups. When anything in a group tree is animating, every display below it is described
// by Molang formulas of the animation clocks instead of numbers, so the CLIENT evaluates the whole assembly every frame
// (a bobbing platform carrying a spinning ring carrying orbiting gems costs the server nothing while it plays).
//
// Each group and display has local channels pos (x,y,z), rot and scale; a channel is a number or, while it animates,
//   from + (to - from) * eased(progress(q.life_time))            (progress: clamp / repeat / pingpong, see tween.cjs)
// and world transforms compose symbolically down the tree. Exact for any yaw (rotation about the vertical axis) in the
// group chain - the case that matters for turntables - using the rotation convention of matrix.cjs:
//   world pos = parent pos + parent scale * R(parent yaw) * local pos     R: x' = x cos - z sin, z' = x sin + z cos
//   world yaw = parent yaw + local yaw       world scale = parent scale * local scale
// A display's own x/z tilt stays its own (rot = [rx, parentYaw + ry, rz]) - exact because Ry(-a) Ry(-b) Rx Rz = Ry(-(a+b)) Rx Rz.

import exprLib from "../expr.cjs";
import tweenLib from "../tween.cjs";
import specLib from "../spec.cjs";
import molang from "../molangEval.cjs";

const { num, vr, add, sub, mul, call, toMolang } = exprLib;
const { progressAssignments } = tweenLib;
const { normalizeSpec } = specLib;

const FM_VAR = /^v\.fm_/;
export const userVars = d => (d.spec.vars ?? []).filter(([name]) => !FM_VAR.test(name));

/** The expression of one local channel component: a number, or the animated lerp using the anim's eased-progress variable. */
function channelExpr(anims, ch, i, local) {
    const a = anims[ch];
    const value = ch === "scale" ? local.scale : local[ch][i];
    if (!a) return num(value);
    const from = ch === "scale" ? a.from : a.from[i];
    const to = ch === "scale" ? a.to : a.to[i];
    return from === to ? num(to) : add(num(from), mul(num(to - from), vr(a.vars.e)));
}

/** Progress-variable assignments for each animation of an entry, minted once per animation so a rebuild never restarts one. */
function progressOf(anims, prefix) {
    const out = [];
    for (const [ch, a] of Object.entries(anims)) {
        a.vars ??= progressAssignments(`${prefix}${ch}${a.id}`, a.opts);
        out.push(...a.vars.assignments);
    }
    return out;
}

const names = id => ({ yaw: `v.fm_wy_${id}`, scale: `v.fm_ws_${id}`, x: `v.fm_wx_${id}`, y: `v.fm_wh_${id}`, z: `v.fm_wz_${id}` });

/**
 * Computes, for every display under `root`, the formula spec patch { pos, rot, scale, vars } (world coordinates, relative to
 * the display's anchor). `anchorFor(display, worldAtLifeTime)` lets the caller re-anchor displays that would swing too far.
 * @returns {Array<{display: object, build: (anchor: object) => object}>}
 */
export function collectDisplays(root) {
    const out = [];
    const walk = (group, parent, inherited) => {
        const n = names(group.id);
        const prog = progressOf(group.anims, `${group.id}`);
        const ch = (c, i) => channelExpr(group.anims, c, i, group.local);
        const here = [
            ...prog,
            [n.yaw, toMolang(add(parent.yaw, ch("rot", 1)))],
            [n.scale, toMolang(mul(parent.scale, ch("scale", 0)))],
            [n.x, toMolang(add(parent.pos[0], mul(parent.scale, sub(mul(ch("pos", 0), call("math.cos", parent.yaw)), mul(ch("pos", 2), call("math.sin", parent.yaw))))))],
            [n.y, toMolang(add(parent.pos[1], mul(parent.scale, ch("pos", 1))))],
            [n.z, toMolang(add(parent.pos[2], mul(parent.scale, add(mul(ch("pos", 0), call("math.sin", parent.yaw)), mul(ch("pos", 2), call("math.cos", parent.yaw))))))],
        ];
        const assigns = [...inherited, ...here];
        const world = { yaw: vr(n.yaw), scale: vr(n.scale), pos: [vr(n.x), vr(n.y), vr(n.z)] };
        children(group, world, assigns);
        for (const g of group.groups) walk(g, world, assigns);
    };
    const children = (group, world, assigns) => {
        group.children.forEach((c, index) => {
            const mine = progressOf(c.anims, `${group.id}d${index}`);
            const ch = (cname, i) => channelExpr(c.anims, cname, i, c.local);
            const cy = call("math.cos", world.yaw), sy = call("math.sin", world.yaw);
            const wx = add(world.pos[0], mul(world.scale, sub(mul(ch("pos", 0), cy), mul(ch("pos", 2), sy))));
            const wy = add(world.pos[1], mul(world.scale, ch("pos", 1)));
            const wz = add(world.pos[2], mul(world.scale, add(mul(ch("pos", 0), sy), mul(ch("pos", 2), cy))));
            out.push({
                display: c.display,
                build: anchor => ({
                    pos: [toMolang(sub(wx, num(anchor.x))), toMolang(sub(wy, num(anchor.y))), toMolang(sub(wz, num(anchor.z)))],
                    rot: [toMolang(ch("rot", 0)), `math.mod(${toMolang(add(world.yaw, ch("rot", 1)))},360)`, toMolang(ch("rot", 2))],
                    scale: toMolang(mul(world.scale, ch("scale", 0))),
                    vars: [...userVars(c.display), ...assigns, ...mine],
                }),
            });
        });
    };
    const identity = { yaw: num(0), scale: num(1), pos: [num(0), num(0), num(0)] };
    walk(root, identity, []);
    return out;
}

/** Simulates a built display over `seconds` of client time and returns its world positions (anchor + offset). */
export function simulatePositions(built, anchor, seconds, steps = 24) {
    const env = {};
    const vars = built.vars.map(([k, v]) => `${k}=${v};`).join("");
    const out = [];
    for (let i = 0; i <= steps; i++) {
        molang.run(`${vars}v.px=${built.pos[0]};v.py=${built.pos[1]};v.pz=${built.pos[2]};`, env, { query: { life_time: seconds * i / steps } });
        out.push({ x: anchor.x + env["v.px"], y: anchor.y + env["v.py"], z: anchor.z + env["v.pz"] });
    }
    return out;
}

/** Applies formulas to every display of the tree, re-anchoring any that would swing farther than `maxOffset` from its entity. */
export function applyFormulas(root, { maxOffset, seconds }) {
    for (const { display, build } of collectDisplays(root)) {
        let built = build(display.anchor);
        let path = simulatePositions(built, display.anchor, seconds);
        const far = (p, a) => Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y), Math.abs(p.z - a.z));
        if (path.some(p => far(p, display.anchor) > maxOffset)) {
            const mid = { x: (Math.min(...path.map(p => p.x)) + Math.max(...path.map(p => p.x))) / 2, y: (Math.min(...path.map(p => p.y)) + Math.max(...path.map(p => p.y))) / 2, z: (Math.min(...path.map(p => p.z)) + Math.max(...path.map(p => p.z))) / 2 };
            const anchor = { x: Math.floor(mid.x) + 0.5, y: mid.y, z: Math.floor(mid.z) + 0.5 };
            built = build(anchor);
            path = simulatePositions(built, anchor, seconds);
            const worst = Math.max(...path.map(p => far(p, anchor)));
            if (worst > maxOffset) throw new Error(`group animation: "${display.label()}" would swing ${worst.toFixed(1)} blocks from its entity (limit ${maxOffset}); shrink the motion or raise maxOffset`);
            display.moveTo(anchor);
        }
        display.running = null;
        display.become(normalizeSpec({ ...display.spec, ...built }, display.label()));
    }
}
