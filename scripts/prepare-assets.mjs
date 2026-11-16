// Converts the Blender export in ./assets into web-ready GLB files in ./public/assets.
//  - drops the very heavy LODs we never draw (impostors cover the distance)
//  - adds a light, meshoptimizer-simplified far LOD for heavy solid props (stumps, trunks, roots, debris)
//  - re-encodes textures as WebP (max 1024px), meshopt-compresses geometry and packs each model into one .glb
//  - copies instance tables, heightfield, lamps and scene.json; when an export comes without grass,
//    the previous grass table is kept and re-seated on the new terrain
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { prune, dedup, textureCompress, simplifyPrimitive, weld, reorder } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('assets');
const OUT = path.resolve('public/assets');
const CACHE = path.resolve('.cache');
const FORCE = process.argv.includes('--force');
fs.mkdirSync(path.join(OUT, 'vegetation'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'instances'), { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const scene = JSON.parse(fs.readFileSync(path.join(SRC, 'scene.json'), 'utf8'));

// which LOD nodes to keep per model, and whether to add a simplified far LOD (target triangles)
function lodPlan(name, lods) {
  const nodes = lods.map((l) => l.node);
  const tris = lods.map((l) => l.triangles);
  const last = (keep) => tris[nodes.indexOf(keep[keep.length - 1])];
  // trees: keep the detailed LODs for close-ups. Pine lod0 (~800k tris) is too heavy even for that.
  if (/^pine_tree/.test(name)) return { keep: nodes.slice(1) };
  // young pines (7-11 m): lod0 is 175k-310k triangles; lod1 (85k-150k) up close, a 7k copy further out
  // (their lod2 was decimated without UVs and renders flat: simplify from the textured lod1 instead)
  if (/^pine_sapling_medium/.test(name)) return { keep: [nodes[1]], simplify: { target: 7000, from: nodes[1] } };
  // knee-high saplings: lod1 (36k-60k) only, impostors take over a few tens of metres out
  if (/sapling/.test(name)) return { keep: nodes.slice(1), simplify: { target: 6000, from: nodes[nodes.length - 1] } };
  // solid wood props: drop the 100k+ scan, add a light far LOD
  if (/dead_tree|stump|root_cluster|pine_roots/.test(name)) {
    const keep = nodes.length > 1 ? nodes.slice(1) : nodes;
    return { keep, simplify: { target: 4000, from: keep[keep.length - 1] } };
  }
  if (/bark_debris/.test(name)) {
    const keep = nodes.length > 1 ? nodes.slice(1) : nodes;
    return { keep, simplify: { target: 1500, from: keep[keep.length - 1] } };
  }
  // scanned rocks (8k-10k triangles, hundreds of them): add a light far LOD
  if (/^rock_moss_set/.test(name) && nodes.length === 1 && tris[0] > 3000) return { keep: nodes, simplify: { target: 1200, from: nodes[0] } };
  if (/dry_branches/.test(name)) return { keep: nodes, simplify: { target: 900, from: nodes[nodes.length - 1] } };
  return { keep: nodes };
}

// adds node `<from>_simp` with a simplified copy of the `from` node's meshes
function addSimplifiedLod(doc, fromName, target) {
  const root = doc.getRoot();
  const src = root.listNodes().find((n) => n.getName() === fromName);
  if (!src) return null;
  const meshSrc = src.getMesh();
  if (!meshSrc) return null;
  const srcTris = meshSrc.listPrimitives().reduce((a, p) => a + (p.getIndices() ? p.getIndices().getCount() / 3 : p.getAttribute('POSITION').getCount() / 3), 0);
  const ratio = Math.min(0.9, target / Math.max(1, srcTris));
  const mesh = doc.createMesh(meshSrc.getName() + '_simp');
  for (const p of meshSrc.listPrimitives()) {
    const q = p.clone();
    // own copies of every accessor: simplification must not touch the source LOD
    for (const sem of q.listSemantics()) q.setAttribute(sem, q.getAttribute(sem).clone());
    if (q.getIndices()) q.setIndices(q.getIndices().clone());
    simplifyPrimitive(q, { simplifier: MeshoptSimplifier, ratio, error: 0.02, lockBorder: false });
    mesh.addPrimitive(q);
  }
  const name = fromName.replace(/__lod\d+$/, '') + '__lodS';
  const node = doc.createNode(name).setMesh(mesh);
  const parent = root.listScenes()[0];
  parent.addChild(node);
  const outTris = mesh.listPrimitives().reduce((a, p) => a + (p.getIndices() ? p.getIndices().getCount() / 3 : 0), 0);
  return { name, srcTris, outTris };
}

async function convert(srcRel, dstRel, plan, maxSize = 1024) {
  const src = path.join(SRC, srcRel);
  const dst = path.join(OUT, dstRel);
  const planSame = !plan || JSON.stringify({ k: plan.keep, s: plan.simplify }) === plan.prevPlan;
  if (!FORCE && planSame && fs.existsSync(dst) && fs.statSync(dst).mtimeMs > fs.statSync(src).mtimeMs) {
    console.log('skip', dstRel);
    return plan?.cachedNodes;
  }
  const t0 = Date.now();
  const doc = await io.read(src);
  const root = doc.getRoot();
  let nodesOut = plan ? [...plan.keep] : null;
  if (plan) {
    let simp = null;
    if (plan.simplify) {
      await doc.transform(weld());
      simp = addSimplifiedLod(doc, plan.simplify.from, plan.simplify.target);
      if (simp) { nodesOut.push(simp.name); console.log(`  simplified ${plan.simplify.from}: ${simp.srcTris} -> ${simp.outTris} tris`); }
    }
    const keepSet = new Set(nodesOut);
    for (const node of root.listNodes()) if (!keepSet.has(node.getName())) node.dispose();
  }
  await doc.transform(
    prune({ keepAttributes: true, keepExtras: true }),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxSize, maxSize], quality: 90 }),
    // lossless EXT_meshopt_compression (no quantisation: geometry stays float, the app code is unchanged).
    // Keeps every file under GitHub's 100 MB limit and the whole site well under the Pages 1 GB limit.
    reorder({ encoder: MeshoptEncoder, target: 'size' })
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  await io.write(dst, doc);
  console.log('wrote', dstRel, (fs.statSync(dst).size / 1e6).toFixed(1) + 'MB', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  return nodesOut;
}

const files = ['terrain', 'backdrop', 'water', 'roads', 'buildings', 'surroundings', 'grass_patch'];
for (const f of files) await convert(f + '.gltf', f + '.glb', null, f === 'terrain' ? 2048 : 1024);

// previous manifest: tells us which nodes a skipped (unchanged) model was written with
const prevManifest = fs.existsSync(path.join(OUT, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) : { models: {} };
const manifest = { models: {} };
const missing = [];
for (const [name, d] of Object.entries(scene.instances.plants.models)) {
  if (!d.model || !fs.existsSync(path.join(SRC, d.model)) || !fs.existsSync(path.join(SRC, d.instances))) { missing.push(name); continue; }
  const plan = lodPlan(name, d.lods);
  plan.cachedNodes = prevManifest.models[name]?.nodes ?? plan.keep;
  plan.prevPlan = prevManifest.models[name]?.plan;
  const nodes = await convert(d.model, `vegetation/${name}.glb`, plan);
  manifest.models[name] = { glb: `vegetation/${name}.glb`, nodes, instances: d.instances, count: d.count, plan: JSON.stringify({ k: plan.keep, s: plan.simplify }) };
}
if (missing.length) console.warn('WARNING: models listed in scene.json but not exported (skipped):', missing.join(', '));

// ------------------------------------------------------------------ grass carry-over
// The exporter only writes the grass table when the turf objects exist in the .blend. Without it we keep the last
// table, and re-seat every patch on the new terrain by the height difference (old heightfield cached in .cache/).
const hfName = 'terrain_height_481x481.f32';
const outScene = JSON.parse(JSON.stringify(scene));
const grassCache = path.join(CACHE, 'grass_tiles.json');
const refHf = path.join(CACHE, 'grass_ref_height.f32');
if (scene.instances.grass) {
  fs.writeFileSync(grassCache, JSON.stringify(scene.instances.grass));
  fs.copyFileSync(path.join(SRC, hfName), refHf);
  fs.copyFileSync(path.join(SRC, 'instances', 'grass.bin'), path.join(OUT, 'instances', 'grass.bin'));
} else {
  if (!fs.existsSync(grassCache)) {
    // first run after an export without grass: the previous public files are the reference
    const prev = JSON.parse(fs.readFileSync(path.join(OUT, 'scene.json'), 'utf8'));
    if (!prev.instances.grass) throw new Error('no grass table anywhere');
    fs.writeFileSync(grassCache, JSON.stringify(prev.instances.grass));
    fs.copyFileSync(path.join(OUT, hfName), refHf);
  }
  outScene.instances.grass = JSON.parse(fs.readFileSync(grassCache, 'utf8'));
  const sampler = (buf) => {
    const d = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4), n = 481;
    return (x, z) => {
      const cx = Math.min(Math.max((x + 1200) / 5, 0), n - 1.001), cy = Math.min(Math.max((-z + 1200) / 5, 0), n - 1.001);
      const ix = Math.floor(cx), iy = Math.floor(cy), tx = cx - ix, ty = cy - iy;
      const h00 = d[iy * n + ix], h10 = d[iy * n + ix + 1], h01 = d[(iy + 1) * n + ix], h11 = d[(iy + 1) * n + ix + 1];
      return tx >= ty ? h00 + (h10 - h00) * tx + (h11 - h10) * ty : h00 + (h11 - h01) * tx + (h01 - h00) * ty;
    };
  };
  const hOld = sampler(fs.readFileSync(refHf)), hNew = sampler(fs.readFileSync(path.join(SRC, hfName)));
  const gb = fs.readFileSync(path.join(SRC, 'instances', 'grass.bin'));
  const g = new Float32Array(gb.buffer.slice(gb.byteOffset, gb.byteOffset + gb.length));
  let moved = 0;
  for (let i = 0; i < g.length; i += 13) {
    const dh = hNew(g[i], g[i + 2]) - hOld(g[i], g[i + 2]);
    if (Math.abs(dh) > 0.02) { g[i + 1] += dh; moved++; }
  }
  fs.writeFileSync(path.join(OUT, 'instances', 'grass.bin'), Buffer.from(g.buffer));
  console.log(`grass: kept previous table, re-seated ${moved} of ${g.length / 13} patches on the new terrain`);
}

for (const f of fs.readdirSync(path.join(SRC, 'instances'))) {
  if (f === 'grass.bin') continue;
  fs.copyFileSync(path.join(SRC, 'instances', f), path.join(OUT, 'instances', f));
}
for (const f of [hfName, 'street_lamps.json']) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify(outScene));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('done');
