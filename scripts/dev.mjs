import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(label, args, color) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env });
  const tag = `\x1b[${color}m[${label}]\x1b[0m`;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) console.log(`${tag} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    console.log(`${tag} exited with code ${code}`);
    if (!devServer) process.exit(code);
  });
  return child;
}

const api = run('api', ['server/index.js'], '36');
run('web', ['node_modules/vite/bin/vite.js'], '35');

let devServer = true;
process.on('SIGINT', () => {
  devServer = false;
  api.kill();
  process.exit(0);
});
