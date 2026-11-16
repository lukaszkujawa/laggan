const fs=require('fs');const s=require(process.cwd()+'/assets/scene.json');const o=require(process.cwd()+'/public/assets/scene.json');
const om=o.instances.plants.models;
for(const [k,v] of Object.entries(s.instances.plants.models)){ if(om[k]) continue;
  const g=JSON.parse(fs.readFileSync('assets/'+v.model));
  // bbox from accessor min/max of POSITION of lod0 meshes
  const lod0=g.nodes.find(n=>n.name===v.lods[0].node);
  let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];const mats=new Set();let uv=true,wind=true;
  const visit=(n)=>{if(n.mesh!==undefined)for(const p of g.meshes[n.mesh].primitives){const a=g.accessors[p.attributes.POSITION];for(let i=0;i<3;i++){mn[i]=Math.min(mn[i],a.min[i]);mx[i]=Math.max(mx[i],a.max[i])}if(!p.attributes.TEXCOORD_0)uv=false;if(p.attributes._WIND===undefined)wind=false;const m=g.materials[p.material];mats.add(m.name+(m.alphaMode?'['+m.alphaMode+']':'')+(m.pbrMetallicRoughness?.baseColorTexture?'T':'')+(m.pbrMetallicRoughness?.baseColorFactor?'('+m.pbrMetallicRoughness.baseColorFactor.map(x=>x.toFixed(2))+')':''))};(n.children||[]).forEach(c=>visit(g.nodes[c]))};
  visit(lod0);
  const r=(b=>new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length)))(fs.readFileSync('assets/'+v.instances));
  let smin=1e9,smax=0,xs=[],zs=[];for(let i=0;i<r.length;i+=10){const sc=Math.max(r[i+7],r[i+8],r[i+9]);smin=Math.min(smin,sc);smax=Math.max(smax,sc);xs.push(r[i]);zs.push(r[i+2])}
  xs.sort((a,b)=>a-b);zs.sort((a,b)=>a-b);const q=(a,f)=>a[Math.floor(a.length*f)].toFixed(0);
  console.log(k.padEnd(28),'size',mx.map((x,i)=>(x-mn[i]).toFixed(2)).join('x'),'sc',smin.toFixed(2)+'-'+smax.toFixed(2),'x',q(xs,.05)+'..'+q(xs,.95),'z',q(zs,.05)+'..'+q(zs,.95),uv?'':'NOUV',wind?'':'NOWIND','|',[...mats].join(' '));
}
