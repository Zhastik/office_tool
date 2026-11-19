import { readFileSync } from 'node:fs';

const headers = JSON.parse(readFileSync(new URL('../server/browser-headers.json', import.meta.url), 'utf8'));
for (const [name, value] of Object.entries(headers)) {
  if (!/^[A-Za-z0-9-]+$/.test(name) || /[\n\r"$\\]/.test(value)) {
    throw new Error('Cannot render Nginx directive for ' + name);
  }
  console.log('add_header ' + name + ' "' + value + '" always;');
}

