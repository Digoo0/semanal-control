import {build} from 'esbuild';
import {mkdir, rm, copyFile, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
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
const [html, css] = await Promise.all(['index.html', 'styles.css'].map(file => readFile(path.join(project, 'src', file), 'utf8')));
const stylesheet = `assets/styles-${createHash('sha256').update(css).digest('hex').slice(0, 12)}.css`;
if (!html.includes('href="./styles.css"')) throw new Error('Referência ao CSS não encontrada no HTML.');
await mkdir(path.join(output, 'assets'), {recursive:true});
await Promise.all([
  writeFile(path.join(output, 'index.html'), html.replace('href="./styles.css"', `href="./${stylesheet}"`)),
  writeFile(path.join(output, stylesheet), css),
  copyFile(path.join(project, 'src', 'icon.svg'), path.join(output, 'icon.svg'))
]);
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Build pronto em dist/ (compatível com subdiretórios do GitHub Pages).');
