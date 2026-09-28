import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const children = [];

function run(command, args) {
  const child = spawn(command, args, {
    cwd: __dirname,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });

  children.push(child);

  child.on('error', (error) => {
    console.error(`Failed to start ${command}: ${error.message}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code !== 0 && code !== null) shutdown(code);
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
});

// Run both processes through Node directly. This avoids Windows shell/path
// parsing problems (especially paths containing spaces such as "Program Files").
run(process.execPath, ['server.js']);
run(process.execPath, [path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js')]);
