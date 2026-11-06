// Offline test: mock VidSpark + AniList, check detection, linking and the API.
const http=require('http'),assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
let movies=[{tmdbid:'100',orig_title:'Old Movie',imdb_id:'tt0000100',year:2020,quality:'HD'}];
let tv=[{tmdbid:'200',orig_title:'Old Show',imdb_id:'tt0000200',year:2021}];
let anime=[{id:1,title:{english:'Frieren',romaji:'Sousou no Frieren',native:''},synonyms:[],coverImage:{large:'p.jpg'},startDate:{year:2023},genres:['Fantasy'],averageScore:90,description:'<b>Elf</b>',format:'TV'}];
let providerHasFrieren=false;
const mock=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c).on('end',()=>{
 const u=new URL(req.url,'http://m');res.setHeader('content-type','application/json');
 if(u.pathname==='/graphql')return res.end(JSON.stringify({data:{Page:{media:anime}}}));
 const kind=u.pathname.split('/').pop(),q=u.searchParams.get('query');let d=kind==='movies'?movies:tv;
 if(q){d=providerHasFrieren&&kind==='tv'&&/frieren/i.test(q)?[{tmdbid:'209867',orig_title:'Frieren',imdb_id:'tt22248376',year:2023}]:[]}
 res.end(JSON.stringify({data:d}))})}).listen(0);
(async()=>{
 await new Promise(r=>mock.on('listening',r));const mp=mock.address().port;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vanta-'));
 Object.assign(process.env,{VIDSPARK_BASE:`http://127.0.0.1:${mp}`,ANILIST_URL:`http://127.0.0.1:${mp}/graphql`,DATA_DIR:dir,PORT:'0',ADMIN_TOKEN:'tok'});
 const app=require('../server.js');app.load();
 await new Promise(r=>app.server.listen(0,r));const port=app.server.address().port;
 const get=async p=>(await fetch(`http://127.0.0.1:${port}${p}`)).json();
 // 1) baseline run: nothing is "new"
 let run=await app.runUpdate('test');assert.equal(run.status,'ok');
 let r=await get('/api/updates');assert.equal(r.titles.length,3);assert(r.titles.every(t=>t.tag!=='NEW'),'baseline must not be NEW');
 const fr=r.titles.find(t=>t.title==='Frieren');assert(!/^vidspark/.test(fr.id)&&fr.playable===false,'anime unmatched yet -> listed but not playable');
 console.log('baseline ok; unmatched anime kept pending:',run.message);
 // 2) new movie + new show + new anime appear; provider now carries Frieren
 movies.unshift({tmdbid:'101',orig_title:'Brand New Movie',imdb_id:'tt0000101',year:2026,quality:'CAM'});
 tv.unshift({tmdbid:'201',orig_title:'Brand New Show',imdb_id:'tt0000201',year:2026});
 anime.unshift({id:2,title:{english:null,romaji:'Kimetsu Test',native:''},synonyms:[],coverImage:{large:'k.jpg'},startDate:{year:2026},genres:['Action'],averageScore:80,description:'x',format:'TV'});
 providerHasFrieren=true;
 run=await app.runUpdate('test');console.log(run.message);
 r=await get('/api/updates');
 const news=r.titles.filter(t=>t.tag==='NEW').map(t=>t.title).sort();
 assert.deepEqual(news,['Brand New Movie','Brand New Show','Kimetsu Test'],'new titles flagged');
 const fr2=r.titles.find(t=>t.title==='Frieren');assert.equal(fr2.id,'vidspark-tv-209867');assert.equal(fr2.playable,true);assert.equal(fr2.imdbId,'tt22248376');
 assert(r.titles.every(t=>t.id===t.id)&&new Set(r.titles.map(t=>t.id)).size===r.titles.length,'no duplicate ids');
 assert.equal(r.run.status,'ok');
 console.log('new titles detected:',news.join(', '),'| Frieren linked ->',fr2.id);
 // 3) search, persistence, admin auth
 assert.equal((await get('/api/updates?q=brand')).titles.length,2);
 assert(fs.existsSync(path.join(dir,'catalog.json')),'persisted');
 assert.equal((await fetch(`http://127.0.0.1:${port}/admin/refresh`,{method:'POST'})).status,401);
 assert.equal((await fetch(`http://127.0.0.1:${port}/admin/refresh`,{method:'POST',headers:{authorization:'Bearer tok'}})).status,200);
 // 4) source outage must not wipe data
 mock.close();run=await app.runUpdate('test');assert.equal(run.status,'failed');
 assert.equal((await get('/api/updates')).titles.length,6);
 console.log('outage handled, data kept. ALL TESTS PASSED');process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
