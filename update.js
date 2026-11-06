// Runs on GitHub Actions: fetch new titles, then write public/updates.json for the static site.
process.env.DATA_DIR = process.env.DATA_DIR || require('path').join(__dirname, '..', 'data');
const fs = require('fs'), path = require('path');
const app = require('../server.js');
(async () => {
  app.load();
  const run = await app.runUpdate('github-actions');
  const out = { titles: app.listUpdates('', 0), run };
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'updates.json'), JSON.stringify(out));
  console.log(`Wrote updates.json with ${out.titles.length} titles — ${run.message}`);
  process.exit(run.status === 'failed' ? 1 : 0);
})();
