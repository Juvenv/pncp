import test from 'node:test';
import assert from 'node:assert/strict';
import { rows, matchesAdhesion } from '../src/parsers.js';
import { Store } from '../src/store.js';

test('parsers reject unknown response shapes', () => {
  assert.deepEqual(rows({ items: [{ id: '1' }] }), [{ id: '1' }]);
  assert.deepEqual(rows({ data: [{ id: '1' }] }), [{ id: '1' }]);
  assert.throws(() => rows({ error: 'upstream' }));
});

test('tri-state adhesion preserves null', () => {
  for (const value of [true, false, null]) {
    assert.equal(matchesAdhesion({ possibilidadeAdesao: value }, null), true);
    assert.equal(matchesAdhesion({ possibilidadeAdesao: value }, true), value === true);
    assert.equal(matchesAdhesion({ possibilidadeAdesao: value }, false), value === false);
  }
});

test('checkpoint is atomic and duplicate pages do not duplicate records', () => {
  const store = new Store(':memory:'); const id = store.start(['computador']);
  assert.throws(() => store.ingest(id, 1, { items: [{ id: 'valid' }, { invalid: true }] }));
  assert.equal(store.summary(id).unique_records, 0);
  store.ingest(id, 1, { items: [{ id: 'valid' }] });
  store.ingest(id, 1, { items: [{ id: 'valid' }] });
  assert.equal(store.summary(id).unique_records, 1);
  assert.equal(store.summary(id).next_page, 2);
  assert.throws(() => store.ingest(id, 3, { items: [] }));
  store.close();
});
