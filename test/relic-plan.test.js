import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRelicEquips } from '../src/strategy.js';

// Helpers to build fixtures.
const pet = (id, rarity, stage = 'Elder', level = 30) => ({ id, rarity, stage, level });
const relic = (id, rarity, extra = {}) => ({ id, rarity, affixes: [{ key: 'attack_pct', value: 0.1 }], ...extra });

test('planRelicEquips: only Legendary pets get relics (minRank 5)', () => {
  const pets = [pet('leg', 'Legendary'), pet('epic', 'Epic'), pet('unc', 'Uncommon')];
  const relics = [relic('r1', 'Rare'), relic('r2', 'Rare'), relic('r3', 'Rare'), relic('r4', 'Rare')];
  const { equips } = planRelicEquips(pets, relics, 5);
  // 1 Legendary pet × 3 slots = 3 equips, none to the Epic/Uncommon pets.
  assert.equal(equips.length, 3);
  assert.ok(equips.every((e) => e.target === 'leg'));
  assert.deepEqual(equips.map((e) => e.slot).sort(), ['combat_a', 'combat_b', 'combat_c']);
});

test('planRelicEquips: fills each of the 3 combat slots', () => {
  const pets = [pet('leg', 'Legendary')];
  const relics = [relic('r1', 'Epic'), relic('r2', 'Epic'), relic('r3', 'Epic')];
  const { equips } = planRelicEquips(pets, relics, 5);
  assert.equal(equips.length, 3);
  assert.deepEqual(new Set(equips.map((e) => e.slot)), new Set(['combat_a', 'combat_b', 'combat_c']));
});

test('planRelicEquips: strongest relics assigned first (best rarity used)', () => {
  const pets = [pet('leg', 'Legendary')];
  const relics = [relic('lo', 'Uncommon'), relic('hi', 'Legendary'), relic('mid', 'Rare')];
  const { equips } = planRelicEquips(pets, relics, 5);
  // First slot gets the Legendary relic (highest relicScore).
  assert.equal(equips[0].relicId, 'hi');
});

test('planRelicEquips: swap-upgrades a weak equipped relic when a stronger free one exists', () => {
  const pets = [pet('leg', 'Legendary')];
  const relics = [
    relic('weak', 'Uncommon', { equipped_on: 'leg', equip_slot: 'combat_a' }),
    relic('weak2', 'Uncommon', { equipped_on: 'leg', equip_slot: 'combat_b' }),
    relic('weak3', 'Uncommon', { equipped_on: 'leg', equip_slot: 'combat_c' }),
    relic('strong', 'Legendary'),
  ];
  const { equips, unequips } = planRelicEquips(pets, relics, 5);
  // The Legendary relic replaces one Uncommon: one unequip + one equip of 'strong'.
  assert.ok(unequips.includes('weak'));
  assert.ok(equips.some((e) => e.relicId === 'strong'));
});

test('planRelicEquips: no target pets → no actions', () => {
  const pets = [pet('epic', 'Epic'), pet('rare', 'Rare')];
  const relics = [relic('r1', 'Epic'), relic('r2', 'Epic')];
  const { equips, unequips } = planRelicEquips(pets, relics, 5);
  assert.equal(equips.length, 0);
  assert.equal(unequips.length, 0);
});

test('planRelicEquips: keeps a correctly-filled slot (no needless churn)', () => {
  const pets = [pet('leg', 'Legendary')];
  const relics = [
    relic('a', 'Epic', { equipped_on: 'leg', equip_slot: 'combat_a' }),
    relic('b', 'Epic', { equipped_on: 'leg', equip_slot: 'combat_b' }),
    relic('c', 'Epic', { equipped_on: 'leg', equip_slot: 'combat_c' }),
    relic('spare', 'Uncommon'),
  ];
  const { equips, unequips } = planRelicEquips(pets, relics, 5);
  // All slots already hold Epic; the Uncommon spare is weaker → nothing changes.
  assert.equal(equips.length, 0);
  assert.equal(unequips.length, 0);
});
