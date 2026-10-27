import {build} from 'esbuild';
import {mkdir, rm, copyFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'dist');
if (path.relative(project, path.resolve(output)) !== 'dist') throw new Error('Diretório de build fora do projeto.');
await rm(output, {recursive:true, force:true});
await mkdir(output, {recursive:true});
await build({
  absWorkingDir:project,
  entryPoints:[path.join(project, 'src', 'app.js')],
  outdir:output,
  entryNames:'app',
  chunkNames:'assets/[name]-[hash]',
  bundle:true,
  splitting:true,
  format:'esm',
  platform:'browser',
  target:['es2022'],
  tsconfigRaw:{},
  minify:true,
  logLevel:'info'
});
await Promise.all(['index.html','styles.css','icon.svg'].map(file => copyFile(path.join(project, 'src', file), path.join(output, file))));
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Build pronto em dist/ (compatível com subdiretórios do GitHub Pages).');
