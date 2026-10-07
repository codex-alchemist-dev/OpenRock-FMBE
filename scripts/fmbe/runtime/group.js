// A group is a rigid assembly of displays and sub-groups: move, rotate or scale the group and everything in it follows.
// Children are given in the group's local space (blocks, degrees); transforms compose through matrix.cjs into each
// child's world pose. An FMBE offset is only reliable within a few blocks of its entity, so a child is re-anchored (its
// fox teleported to the cell nearest its world position) whenever its offset would grow past `maxOffset`.
//
// Animation: any number of channels (pos / rot / scale) of any groups and displays in the tree can animate AT ONCE, each with
// its own duration, easing and loop. While anything animates, groupFormulas.js turns the whole tree into client-side Molang;
// when nothing does, plain numbers are sent. Rotating animations must be about the vertical axis (yaw): that is what the
// formulas express exactly. One-off tilts animate as straight pieces and need a tree with no other animation.

import matrix from "../matrix.cjs";
import ease from "../ease.cjs";
import exprLib from "../expr.cjs";
import { easedProgress } from "./sample.js";
import { applyFormulas, userVars } from "./groupFormulas.js";

const { composeTransforms } = matrix;
const { easeTree } = ease;
const { evaluate } = exprLib;

const near0 = v => Math.abs(v) < 1e-9;
const IDENTITY = () => ({ pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 });
const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const mix = (a, b, k) => ({ pos: lerp3(a.pos, b.pos, k), rot: lerp3(a.rot, b.rot, k), scale: a.scale + (b.scale - a.scale) * k });
const complete = t => ({ pos: t?.pos ?? [0, 0, 0], rot: t?.rot ?? [0, 0, 0], scale: t?.scale ?? 1 });
const CHANNELS = ["pos", "rot", "scale"];
let animSeq = 0;

export class Group {
    /**
     * @param {object} fmbe the manager
     * @param {{id?: string, dimension: object, local?: object, parent?: Group, owner?: string, persist?: boolean, maxOffset?: number, handedness?: 1|-1}} opts
     *   `local` is relative to `parent`, or the absolute world transform for a root group.
     */
    constructor(fmbe, opts) {
        this.fmbe = fmbe;
        this.id = opts.id ?? `g${Math.floor(Math.random() * 1e9).toString(36)}`;
        this.dimension = opts.dimension;
        this.parent = opts.parent ?? null;
        this.owner = opts.owner;
        this.persist = !!opts.persist;
        this.maxOffset = opts.maxOffset ?? 4;
        this.handedness = opts.handedness ?? 1;
        this.local = { ...IDENTITY(), ...(opts.local ?? opts.transform ?? {}) };   // channel TARGETS: where each channel is or will end up
        this.anims = {};              // channel -> { id, from, to, opts, start }
        this.children = [];           // { display, local, anims }
        this.groups = [];
        this.timers = [];
    }

    compose(parent, child) { return composeTransforms(parent, child, { handedness: this.handedness }); }
    root() { return this.parent ? this.parent.root() : this; }

    /** This group's world transform (numbers), optionally with `local` replaced. Ignores running animations: it is the target. */
    world(local = this.local) { return this.parent ? this.compose(this.parent.world(), local) : local; }

    // ---- structure ----
    /** Adds a display at `local` = { pos, rot, scale } relative to this group (the spec's own pos/rot/scale are replaced by it). */
    add(spec, local = {}) {
        const l = complete(local);
        const world = this.compose(this.world(), l);
        const anchor = this.snap(world.pos);
        const display = this.fmbe.spawn(this.dimension, anchor, { ...spec, ...this.pose(world, anchor) }, { owner: this.owner, persist: this.persist, group: this });
        this.children.push({ display, local: l, anims: {} });
        if (this.root().animating()) this.root().render();
        return display;
    }

    /** Adds a sub-group whose transform is relative to this one. */
    addGroup(local = {}, opts = {}) {
        const g = new Group(this.fmbe, { dimension: this.dimension, owner: this.owner, persist: this.persist, maxOffset: this.maxOffset, handedness: this.handedness, ...opts, parent: this, local });
        this.groups.push(g);
        return g;
    }

    snap(p) { return { x: Math.floor(p[0]) + 0.5, y: p[1], z: Math.floor(p[2]) + 0.5 }; }
    pose(world, anchor) { return { pos: [world.pos[0] - anchor.x, world.pos[1] - anchor.y, world.pos[2] - anchor.z], rot: world.rot, scale: world.scale }; }

    // ---- state ----
    /** True while any channel anywhere below animates. */
    animating() { return Object.keys(this.anims).length > 0 || this.children.some(c => Object.keys(c.anims).length > 0) || this.groups.some(g => g.animating()); }

    /** The value of an animating entry's channels right now (server clock), so a new animation can start from it. */
    sample(entry) {
        const out = { pos: [...entry.local.pos], rot: [...entry.local.rot], scale: entry.local.scale };
        for (const [ch, a] of Object.entries(entry.anims)) {
            const k = easedProgress(a.opts, this.fmbe.now() - a.start);
            if (ch === "scale") out.scale = a.from + (a.to - a.from) * k; else out[ch] = lerp3(a.from, a.to, k);
        }
        return out;
    }

    /** Re-renders the whole tree from the root: formulas while something animates, plain numbers otherwise. */
    render() {
        const root = this.root();
        if (root.animating()) {
            const longest = Math.max(1, ...root.allAnims().map(a => a.opts.ticks)) / 20;
            applyFormulas(root, { maxOffset: this.maxOffset, seconds: longest * 2 });
        } else root.layout(root.world());
    }

    allAnims(out = []) {
        for (const a of Object.values(this.anims)) out.push(a);
        for (const c of this.children) for (const a of Object.values(c.anims)) out.push(a);
        for (const g of this.groups) g.allAnims(out);
        return out;
    }

    /** Lays everything out under world transform `w` as plain numbers; with `tween` each display animates there on its own. */
    layout(w, tween) {
        for (const c of this.children) this.placeChild(c, this.compose(w, c.local), tween);
        for (const g of this.groups) g.layout(this.compose(w, g.local), tween);
    }

    placeChild(child, world, tween, extra = {}) {
        const d = child.display;
        let anchor = d.anchor;
        const rel = [world.pos[0] - anchor.x, world.pos[1] - anchor.y, world.pos[2] - anchor.z];
        if (Math.max(...rel.map(Math.abs)) > this.maxOffset) { anchor = this.snap(world.pos); d.moveTo(anchor); }
        const patch = { ...this.pose(world, anchor), vars: userVars(d), ...extra };
        if (tween) d.tween(patch, tween); else d.set(patch);
    }

    // ---- changing things ----
    /** Sets (part of) this group's transform now, ending any animation of those channels. */
    set(patch) {
        this.cancel();
        for (const ch of CHANNELS) { if (patch[ch] !== undefined) delete this.anims[ch]; }
        this.local = { ...this.local, ...patch };
        this.render();
        return this;
    }

    /**
     * Changes one child display. pos/rot/scale are in this group's local space; anything else (item, extend, ...) goes to the
     * display. With `tween` the spatial channels animate (client side, composed with every other running animation).
     */
    updateChild(display, patch, tween) {
        const child = this.children.find(c => c.display === display);
        if (!child) throw new Error("that display is not a direct child of this group");
        const spatial = {}, rest = {};
        for (const [k, v] of Object.entries(patch)) (CHANNELS.includes(k) ? spatial : rest)[k] = v;
        if (Object.keys(rest).length) display.set(rest);
        if (tween) this.start(child, spatial, tween, `"${display.label()}"`);
        else {
            for (const ch of Object.keys(spatial)) delete child.anims[ch];
            child.local = { ...child.local, ...spatial };
            this.render();
        }
    }

    /**
     * Animates this group's channels. Any number of channels, groups and displays may animate at once. Yaw rotations are exact
     * for any angle and any loop; a tilting rotation runs as straight pieces and needs nothing else animating.
     * @param {{ticks?: number, ease?: string, loop?: "none"|"repeat"|"pingpong", steps?: number}} [opts]
     */
    tween(patch, opts = {}) {
        this.start(this, patch, opts, `group ${this.id}`);
        return this;
    }

    start(entry, patch, { ticks = 20, ease: easing = "linear", loop = "none", steps = 1 } = {}, label) {
        const now = this.sample(entry);
        const next = { pos: patch.pos ?? now.pos, rot: patch.rot ?? now.rot, scale: patch.scale ?? now.scale };
        const tilts = !near0(next.rot[0] - now.rot[0]) || !near0(next.rot[2] - now.rot[2]);
        if (tilts || !this.yawChain(entry === this ? null : this)) {
            if (loop !== "none") throw new Error(`${label}: looping a tilting rotation is not supported - rotate about the vertical axis (yaw), or loop with steps instead`);
            if (this.root().animating()) throw new Error(`${label}: a tilting rotation can only animate while nothing else in the tree does`);
            this.pieces(entry, now, next, { ticks, ease: easing, steps });
            return;
        }
        for (const ch of CHANNELS) {
            if (patch[ch] === undefined) continue;
            const from = ch === "scale" ? now.scale : [...now[ch]];
            const to = ch === "scale" ? next.scale : [...next[ch]];
            const same = ch === "scale" ? from === to : from.every((v, i) => v === to[i]);
            if (same) { delete entry.anims[ch]; continue; }
            const a = { id: ++animSeq, from, to, opts: { ticks, ease: easing, loop }, start: this.fmbe.now() };
            entry.anims[ch] = a;
            entry.local[ch] = to;
            if (loop === "none") this.timers.push(this.fmbe.later(ticks + 1, () => { if (entry.anims[ch] === a) { delete entry.anims[ch]; this.render(); } }));
        }
        this.render();
    }

    /** Whether this group's and every ancestor's rotation is about the vertical axis only (what the formulas express). */
    yawChain(group) {
        for (let g = group ?? this; g; g = g.parent) if (!near0(g.local.rot[0]) || !near0(g.local.rot[2])) return false;
        return true;
    }

    /** A tilting rotation of a group: straight pieces, one per 90 degrees (or `steps`), each a display tween. */
    pieces(entry, from, to, { ticks, ease: easing, steps }) {
        if (entry !== this) throw new Error("a tilting rotation can only animate a whole group, not a single display");
        const delta = Math.max(...to.rot.map((v, i) => Math.abs(v - from.rot[i])));
        const n = Math.max(steps, Math.ceil(delta / 90), 1);
        const shaped = easeTree(easing);
        const seg = Math.max(1, Math.round(ticks / n));
        this.local = { ...to };
        const run = k => {
            const t = n === 1 ? to : mix(from, to, evaluate(shaped, { u: k / n }));
            this.layout(this.world(t), { ticks: seg, ease: n === 1 ? easing : "linear" });
            if (k < n) this.timers.push(this.fmbe.later(seg, () => run(k + 1)));
        };
        run(1);
    }

    /** Freezes the animations of one child display where they are. */
    stopChild(display) {
        const child = this.children.find(c => c.display === display);
        if (!child) throw new Error("that display is not a direct child of this group");
        child.local = this.sample(child);
        child.anims = {};
        this.render();
    }

    /** Freezes every animation in this subtree where it is (plain numbers replace the client formulas). */
    stop() {
        this.cancel();
        const freeze = e => { e.local = this.sample(e); e.anims = {}; };
        const walk = g => { freeze(g); for (const c of g.children) freeze(c); for (const s of g.groups) walk(s); };
        walk(this);
        this.render();
        return this;
    }

    cancel() { for (const t of this.timers) t.cancel(); this.timers = []; }

    remove() {
        this.cancel();
        for (const c of this.children) c.display.remove();
        for (const g of this.groups) g.remove();
        this.children = [];
        this.groups = [];
    }
}
