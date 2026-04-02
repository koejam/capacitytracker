const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  const result = await esbuild.build({
    entryPoints: ['entry.jsx'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    jsx: 'automatic',
    write: false,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  });

  const js = result.outputFiles[0].text;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Capacity Planner</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; width: 100%; }
body { overflow: hidden; }
@media print {
  body, html, #root { height: auto !important; overflow: visible !important; }
}
</style>
</head>
<body>
<div id="root"></div>
<script>
${js}
</script>
</body>
</html>`;

  fs.writeFileSync('capacity-planner.html', html);
  console.log('Built capacity-planner.html (' + Math.round(html.length / 1024) + 'KB)');
}

build().catch(e => { console.error(e); process.exit(1); });
