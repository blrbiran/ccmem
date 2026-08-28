import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// WHY: 这个开关关掉的是跨项目隔离。默认值一旦漂成 true，每个装了 ccmem 的
// 项目都会开始互相看见对方的记忆，而且没有任何报错。这条断言是那件事的唯一闸门。
test('disable_scope_isolation defaults to false', () => {
  assert.equal(DEFAULT_CONFIG.eval.disable_scope_isolation, false);
});

// WHY: config.default.json 是给用户抄的模板。它和 DEFAULT_CONFIG 值不一致时，
// 照模板起手的用户拿到的生效值与产品默认值不同，而 diagnose 会把它报成"非默认"。
test('config.default.json carries the same value', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
  assert.equal(tpl.eval.disable_scope_isolation, false);
});
