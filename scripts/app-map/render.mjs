// scripts/app-map/render.mjs
// Pure string templating. No external assets. Tree + drift inlined as JSON.

export function renderHtml({ tree, drift, generatedNote }) {
  const data = JSON.stringify({ tree, drift, generatedNote }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Apex Health OS — App Map</title>
<style>
:root{--bg:#0c0e12;--panel:#14171d;--line:#252a33;--fg:#e7e9ee;--muted:#8a93a3;--accent:#6ea8fe;--warn:#e0b341;--stale:#e06c6c;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,'DM Sans',sans-serif;}
header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-weight:600}
#search{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 10px;min-width:200px}
.note{color:var(--muted);font-size:12px}
#wrap{display:flex;min-height:calc(100dvh - 52px)}
#tree{flex:1;padding:14px 18px;overflow:auto;max-width:62%}
#detail{width:38%;border-left:1px solid var(--line);padding:18px;position:sticky;top:0;align-self:flex-start;max-height:100dvh;overflow:auto}
ul{list-style:none;margin:0;padding-left:16px}
li{margin:2px 0}
.row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer}
.row:hover{background:var(--panel)}
.row.sel{background:#1b2330;outline:1px solid var(--accent)}
.tw{width:14px;color:var(--muted);font-size:11px;user-select:none}
.leaf .tw{visibility:hidden}
.badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid}
.badge.stale{color:var(--stale);border-color:var(--stale)}
.badge.undocumented{color:var(--warn);border-color:var(--warn)}
.hidden{display:none}
#detail h2{margin:0 0 8px;font-size:18px}
#detail .uh{margin-top:14px;color:var(--muted);font-size:12px;border-top:1px dashed var(--line);padding-top:10px}
#detail .uh code{color:#9fb4cf}
#crumb{color:var(--muted);font-size:12px;margin-bottom:10px}
#drift{margin-top:18px;font-size:12px;color:var(--muted)}
#drift b{color:var(--warn)}
</style></head>
<body>
<header>
  <h1>Apex Health OS — App Map</h1>
  <input id="search" placeholder="Search…" autocomplete="off"/>
  <span class="note" id="gen"></span>
</header>
<div id="wrap">
  <div id="tree"></div>
  <div id="detail"><div id="crumb"></div><div id="body"><p class="note">Pick a branch on the left to read about it.</p></div></div>
</div>
<script>
const DATA = ${data};
const parents = new Map();
function tag(node,parent){ parents.set(node.id, parent); (node.children||[]).forEach(c=>tag(c,node)); }
tag(DATA.tree, null);
document.getElementById('gen').textContent = DATA.generatedNote || '';

function el(t,props={},...kids){const e=document.createElement(t);Object.assign(e,props);for(const k of kids)e.append(k);return e;}

function renderNode(node){
  const li=el('li');
  const hasKids=(node.children||[]).length>0;
  const row=el('div',{className:'row'+(hasKids?'':' leaf')});
  const tw=el('span',{className:'tw',textContent:hasKids?'▸':'•'});
  row.append(tw, el('span',{textContent:node.label}));
  for(const b of node.badges||[]) row.append(el('span',{className:'badge '+b,textContent:b}));
  row.dataset.id=node.id;
  let kidsUl=null;
  if(hasKids){ kidsUl=el('ul',{className:'hidden'}); for(const c of node.children) kidsUl.append(renderNode(c)); }
  row.onclick=(e)=>{
    e.stopPropagation();
    if(hasKids){ kidsUl.classList.toggle('hidden'); tw.textContent=kidsUl.classList.contains('hidden')?'▸':'▾'; }
    select(node);
  };
  li.append(row); if(kidsUl) li.append(kidsUl);
  return li;
}

function select(node){
  document.querySelectorAll('.row.sel').forEach(r=>r.classList.remove('sel'));
  const row=document.querySelector('.row[data-id="'+CSS.escape(node.id)+'"]'); if(row) row.classList.add('sel');
  const crumb=[]; let p=node; while(p){crumb.unshift(p.label); p=parents.get(p.id);}
  document.getElementById('crumb').textContent=crumb.join('  ›  ');
  const body=document.getElementById('body'); body.textContent='';
  body.append(el('h2',{textContent:node.label}));
  if(node.description) body.append(el('p',{textContent:node.description}));
  if((node.underHood||[]).length){
    const uh=el('div',{className:'uh'}); uh.append(el('div',{textContent:'Under the hood'}));
    for(const u of node.underHood){ const c=el('code',{textContent:u}); uh.append(el('div',{},c)); }
    body.append(uh);
  }
}

const rootUl=el('ul'); rootUl.append(renderNode(DATA.tree));
document.getElementById('tree').append(rootUl);
// expand root by default
document.querySelector('.row').click();

// search: show only rows whose label matches, plus ancestors; expand matches.
const search=document.getElementById('search');
search.oninput=()=>{
  const q=search.value.trim().toLowerCase();
  document.querySelectorAll('#tree li').forEach(li=>li.classList.remove('hidden'));
  document.querySelectorAll('#tree ul').forEach(u=>{ if(u.parentElement.tagName==='LI'&&!q) u.classList.add('hidden'); });
  if(!q){
    // reset toggle arrows on parent rows
    document.querySelectorAll('#tree .row').forEach(row=>{ if(row.nextElementSibling&&row.nextElementSibling.tagName==='UL'){ const tw=row.querySelector('.tw'); if(tw) tw.textContent='▸'; } });
    return;
  }
  document.querySelectorAll('#tree .row').forEach(row=>{
    const match=row.textContent.toLowerCase().includes(q);
    if(match){ let li=row.closest('li'); while(li){ li.classList.remove('hidden'); const ul=li.parentElement.closest('li'); const sub=li.querySelector(':scope > ul'); if(sub) sub.classList.remove('hidden'); li=ul; } }
  });
  // hide non-matching items — iterate in reverse DOM order so leaves are hidden before ancestors
  [...document.querySelectorAll('#tree li')].reverse().forEach(li=>{
    const row=li.querySelector(':scope > .row');
    const anyVisibleChild=li.querySelector(':scope > ul > li:not(.hidden)');
    if(row && !row.textContent.toLowerCase().includes(q) && !anyVisibleChild) li.classList.add('hidden');
  });
};

// drift footer in detail panel
if((DATA.drift.undocumented.length+DATA.drift.stale.length)>0){
  const d=el('div',{id:'drift'});
  if(DATA.drift.undocumented.length) d.append(el('div',{},el('b',{textContent:'Undocumented in code: '}), document.createTextNode(DATA.drift.undocumented.join(', '))));
  if(DATA.drift.stale.length) d.append(el('div',{},el('b',{textContent:'Stale (described but gone): '}), document.createTextNode(DATA.drift.stale.join(', '))));
  document.getElementById('detail').append(d);
}
</script>
</body></html>
`;
}
