import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRaidPhase, pickFloor } from '../src/strategy.js';

test('decideRaidPhase: seeds into raid and tracks observed max', () => {
  const s = decideRaidPhase(undefined, 174, {});
  assert.equal(s.phase, 'raid');
  assert.equal(s.staminaMax, 174);
});

test('decideRaidPhase: raid -> farm when stamina drained below cheapest floor', () => {
  const s = decideRaidPhase({ phase: 'raid', staminaMax: 174 }, 4, { cheapest: 6 });
  assert.equal(s.phase, 'farm');
});

test('decideRaidPhase: stays raid while stamina still affords the cheapest floor', () => {
  const s = decideRaidPhase({ phase: 'raid', staminaMax: 174 }, 6, { cheapest: 6 });
  assert.equal(s.phase, 'raid');
});

test('decideRaidPhase: farm holds until stamina refills past the refill fraction (hysteresis)', () => {
  const mid = decideRaidPhase({ phase: 'farm', staminaMax: 174 }, 150, { refillFrac: 0.9 });
  assert.equal(mid.phase, 'farm'); // 150 < 174*0.9=156.6
  const full = decideRaidPhase({ phase: 'farm', staminaMax: 174 }, 160, { refillFrac: 0.9 });
  assert.equal(full.phase, 'raid'); // 160 >= 156.6
});

test('decideRaidPhase: observed max climbs as stamina cap grows with level', () => {
  const s = decideRaidPhase({ phase: 'farm', staminaMax: 174 }, 200, { refillFrac: 0.9 });
  assert.equal(s.staminaMax, 200);
});

test('pickFloor: unknown power -> highest affordable floor (to learn actual power)', () => {
  const floors = [{ id: 3, staminaCost: 10 }, { id: 2, staminaCost: 6 }, { id: 1, staminaCost: 6 }];
  const f = pickFloor(floors, null, 20, (id) => 100 * id);
  assert.equal(f.id, 3);
});

test('pickFloor: matches floor to detected party power', () => {
  const floors = [{ id: 3, staminaCost: 10 }, { id: 2, staminaCost: 6 }, { id: 1, staminaCost: 6 }];
  // reqPower: f1=100, f2=200, f3=300. power 250 -> highest clearable = f2.
  const f = pickFloor(floors, 250, 20, (id) => 100 * id);
  assert.equal(f.id, 2);
});

test('pickFloor: respects remaining stamina (cannot pick an unaffordable floor)', () => {
  const floors = [{ id: 3, staminaCost: 10 }, { id: 2, staminaCost: 6 }, { id: 1, staminaCost: 6 }];
  const f = pickFloor(floors, 999, 6, (id) => 100 * id); // only 6 stamina -> f3 (cost10) excluded
  assert.equal(f.staminaCost <= 6, true);
});

test('pickFloor: no affordable floor -> null', () => {
  const floors = [{ id: 1, staminaCost: 6 }];
  assert.equal(pickFloor(floors, 100, 4, (id) => 100 * id), null);
});

// Regression for the "everything raids floor 1" bug: a STRONG party (seeded from the
// max power ever detected) must climb deep; a WEAK party correctly stays on floor 1.
// Uses the real dungeonReqPower (region-1 floors all cost 6 stamina). reqPower:
// f1≈124, f2≈459, f3≈1002.
test('pickFloor: strong party (power 1299) climbs to floor 3, not floor 1', () => {
  const region1 = [3, 2, 1].map((id) => ({ id, staminaCost: 6 }));
  assert.equal(pickFloor(region1, 1299, 174).id, 3);
});

test('pickFloor: weak party (power 321) correctly stays on floor 1', () => {
  const region1 = [3, 2, 1].map((id) => ({ id, staminaCost: 6 }));
  assert.equal(pickFloor(region1, 321, 174).id, 1);
});
