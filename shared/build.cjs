const fs = require('fs');
const path = require('path');

const srcEsm = path.resolve(__dirname, 'dist/index.js');
const targetCjs = path.resolve(__dirname, 'dist/index.cjs');

if (fs.existsSync(srcEsm)) {
  let content = fs.readFileSync(srcEsm, 'utf8');
  // Transform ES export var to CJS exports
  const header = `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n`;
  content = content.replace(/export var ([A-Za-z0-9_]+);/g, 'var $1;\nexports.$1 = void 0;');
  content = content.replace(/\(([A-Za-z0-9_]+) \|\| \(\1 = \{\}\)\);/g, '($1 || (exports.$1 = $1 = {}));');
  fs.writeFileSync(targetCjs, header + content);
}
