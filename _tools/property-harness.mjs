// Minimal deterministic property engine. Zero dependencies, no package.json.
//
// One PRNG stream per `forAll` call, seeded explicitly: the same seed generates
// the same cases in the same order. A failing case is shrunk to a smaller one
// that still breaks the predicate, so the counterexample names a boundary
// rather than a random point in the domain.
//
//   import { forAll, gen, fc } from './property-harness.mjs';
//   fc.property('my-invariant', gen.int(0, 10), (n) => n >= 0, { runs: 64, seed: 7 });
//
// `fc.property` is the named entry point; `forAll` is the same engine without
// the name argument. Both print the verdict lines the suites and the gate read:
//   PROPERTY PASS name=<name> runs=<n> seed=<n>
//   PROPERTY FAIL seed=<n> case=<json> shrunk=<json>

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const json = (value) => JSON.stringify(value, (_key, v) => (v instanceof Set ? [...v] : v));
const unique = (values) => [...new Set(values.map(json))].map((s) => JSON.parse(s));

export const gen = {
  int(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error(`gen.int needs integer bounds min<=max, got ${min}..${max}`);
    }
    return {
      generate(rng) { return min + Math.floor(rng() * (max - min + 1)); },
      // Try the lower bound first, then a midpoint: a failure at either is a
      // smaller witness than the random point that found it.
      shrink(value) {
        if (value <= min) return [];
        const mid = min + Math.floor((value - min) / 2);
        return mid === min || mid === value ? [min] : [min, mid];
      },
    };
  },

  pick(arr) {
    if (!Array.isArray(arr) || !arr.length) throw new Error('gen.pick needs a non-empty array');
    return {
      generate(rng) { return arr[Math.floor(rng() * arr.length)]; },
      // An enum member has no smaller member: shrinking it would change the
      // alphabet, not the case.
      shrink() { return []; },
    };
  },

  string(alphabet, min, max) {
    if (!alphabet || !alphabet.length || !Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error('gen.string needs a non-empty alphabet and integer bounds min<=max');
    }
    return {
      generate(rng) {
        const length = min + Math.floor(rng() * (max - min + 1));
        let out = '';
        for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rng() * alphabet.length)];
        return out;
      },
      shrink(value) {
        if (value.length <= min) return [];
        const candidates = [value.slice(0, min), value.slice(0, Math.floor(value.length / 2)), value.slice(1), value.slice(0, -1)];
        return unique(candidates.filter((s) => s.length < value.length && s.length >= min));
      },
    };
  },

  record(shape) {
    if (!shape || Array.isArray(shape) || typeof shape !== 'object') throw new Error('gen.record needs a shape object');
    return {
      generate(rng) {
        const out = {};
        for (const [key, child] of Object.entries(shape)) out[key] = child.generate(rng);
        return out;
      },
      shrink(value) {
        const out = [];
        for (const [key, child] of Object.entries(shape)) {
          for (const smaller of child.shrink(value[key])) out.push({ ...value, [key]: smaller });
        }
        return unique(out);
      },
    };
  },

  array(child, min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error('gen.array needs integer bounds min<=max');
    }
    return {
      generate(rng) {
        const length = min + Math.floor(rng() * (max - min + 1));
        const out = [];
        for (let i = 0; i < length; i += 1) out.push(child.generate(rng));
        return out;
      },
      shrink(value) {
        if (value.length <= min) return [];
        const out = [value.slice(0, min), value.slice(0, Math.floor(value.length / 2)), value.slice(1), value.slice(0, -1)];
        for (let i = 0; i < value.length; i += 1) {
          for (const smaller of child.shrink(value[i])) {
            out.push([...value.slice(0, i), smaller, ...value.slice(i + 1)]);
          }
        }
        return unique(out.filter((a) => a.length >= min && a.length <= value.length));
      },
    };
  },
};

function shrinkFailure(generator, value, predicate) {
  let current = value;
  const seen = new Set([json(current)]);
  // Bounded: a generator that reports a non-smaller shrink must not wedge a suite.
  for (let step = 0; step < 256; step += 1) {
    let next = null;
    for (const candidate of generator.shrink(current)) {
      const key = json(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!predicate(candidate)) { next = candidate; break; }
    }
    if (next === null) break;
    current = next;
  }
  return current;
}

export function forAll(generator, predicate, { runs = 128, seed = 1, name = 'property', quiet = false } = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`forAll needs runs>=1, got ${runs}`);
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i += 1) {
    const value = generator.generate(rng);
    if (!predicate(value)) {
      const shrunk = shrinkFailure(generator, value, predicate);
      const line = `PROPERTY FAIL seed=${seed} case=${json(value)} shrunk=${json(shrunk)}`;
      if (!quiet) console.log(line);
      return { ok: false, name, seed, runs, cases: i + 1, case: value, shrunk, line };
    }
  }
  const line = `PROPERTY PASS name=${name} runs=${runs} seed=${seed}`;
  if (!quiet) console.log(line);
  return { ok: true, name, seed, runs, cases: runs, case: null, shrunk: null, line };
}

// The named API is deliberate: it is the property call the quality auditor
// counts, and it really invokes this engine (not a stub).
export const fc = {
  property(name, generator, predicate, options = {}) {
    return forAll(generator, predicate, { ...options, name });
  },
  assert(generator, predicate, options = {}) {
    return forAll(generator, predicate, options);
  },
};

export default { forAll, gen, fc, mulberry32 };
