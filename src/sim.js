'use strict';

// Deterministic release simulation. Everything is derived from the persisted
// game seed plus a per-release hidden "mojo" parameter block, so a given
// (seed, catalogue, submissions) always replays identically. No Math.random()
// anywhere in the simulation path.

// FNV-1a string hash -> uint32 seed
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VARIANTS = ['spike', 'steady', 'short hit', 'burner', 'long decline'];
const USER_VARIANTS = ['spike', 'burner', 'spike', 'steady', 'burner', 'short hit', 'long decline']; // weighted: users skew hit-shaped
const BASE_SALES = 60000;
const NOISE_WEEKS = 80;

function makeMojo(rng, kind, superBand = false) {
  if (superBand) {
    return {
      potential: 0.9 + rng() * 0.1,
      debut: 0.8 + rng() * 0.2,
      climb: rng() * 0.35,
      plateau: 0.75 + rng() * 0.25,
      decline: 0.92 + rng() * 0.08,
      variation: rng() * 0.2,
      variant: 'super band',
      noise: Array.from({ length: NOISE_WEEKS }, () => rng()),
    };
  }
  // User submissions sample a potential band overlapping the rivals', so they
  // have a real shot at the Top 10 without it being guaranteed. Weekly noise
  // and variant curves (incl. short hit) still decide individual weeks.
  const potential = kind === 'user' ? 0.25 + rng() * 0.7 : rng() * 0.95;
  return {
    potential,
    debut: rng(),
    climb: rng(),
    plateau: rng(),
    decline: rng(),
    variation: rng(),
    variant: (kind === 'user' ? USER_VARIANTS : VARIANTS)[Math.floor(rng() * (kind === 'user' ? USER_VARIANTS : VARIANTS).length)],
    noise: Array.from({ length: NOISE_WEEKS }, () => rng()),
  };
}

// Weekly sales for week index w (0 = debut week). Pure function of the
// persisted mojo, so replays are exact.
function weeklySales(release, w) {
  const m = release.mojo;
  const peak = 0.35 + m.potential * 1.15;
  let climbWeeks = 1 + Math.round(m.climb * 6);   // 1..7
  let plateauWeeks = Math.round(m.plateau * 5);   // 0..5
  let retain = 0.5 + m.decline * 0.45;            // 0.50..0.95 weekly retention
  switch (m.variant) {
    case 'super band': climbWeeks = 1 + Math.round(m.climb * 3); plateauWeeks = 5 + Math.round(m.plateau * 4); retain = 0.92 + m.decline * 0.06; break;
    case 'spike': climbWeeks = Math.min(climbWeeks, 2); plateauWeeks = Math.min(plateauWeeks, 1); retain = Math.min(retain, 0.55); break;
    case 'short hit': climbWeeks = Math.min(climbWeeks, 1); plateauWeeks = Math.min(plateauWeeks, 1); retain = 0.35; break;
    case 'steady': plateauWeeks += 3; retain = Math.max(retain, 0.8); break;
    case 'burner': climbWeeks += 2; plateauWeeks += 2; break;
    case 'long decline': plateauWeeks += 1; retain = Math.max(retain, 0.88); break;
  }
  let f;
  if (w < climbWeeks) f = (0.25 + 0.75 * (w + 1) / climbWeeks) * peak;
  else if (w < climbWeeks + plateauWeeks) f = peak;
  else f = peak * Math.pow(retain, w - climbWeeks - plateauWeeks);
  if (w === 0) f *= 0.5 + m.debut * 0.7;
  f *= 1 + (m.noise[Math.min(w, m.noise.length - 1)] - 0.5) * m.variation * 0.8;
  return Math.max(0, Math.round(BASE_SALES * f));
}

module.exports = { hashSeed, mulberry32, makeMojo, weeklySales, VARIANTS };
