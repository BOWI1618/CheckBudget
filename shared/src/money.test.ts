import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, parseRate, parseAmount, formatMoney, toInputValue, plural, countOf } from './money.js';

test('parseRate не теряет точность', () => {
  assert.deepEqual(parseRate('92.4567'), { num: 924567, den: 10000 });
  assert.deepEqual(parseRate('1'), { num: 1, den: 1 });
  assert.deepEqual(parseRate('0.0001'), { num: 1, den: 10000 });
});

test('convert: USD -> RUB, одинаковый exponent', () => {
  // 100.00 USD по курсу 92.4567 = 9245.67 RUB
  assert.equal(convert(10000, 'USD', 'RUB', parseRate('92.4567')), 924567);
});

test('convert: RUB -> JPY, разный exponent', () => {
  // 1000.00 RUB по курсу 1.6 = 1600 JPY (exponent 0)
  assert.equal(convert(100000, 'RUB', 'JPY', parseRate('1.6')), 1600);
});

test('convert: JPY -> RUB, разный exponent в другую сторону', () => {
  // 1000 JPY по курсу 0.625 = 625.00 RUB
  assert.equal(convert(1000, 'JPY', 'RUB', parseRate('0.625')), 62500);
});

test('convert округляет half-up ровно один раз', () => {
  // 0.01 USD * 92.455 = 0.92455 RUB -> 0.92 (округление вниз, 5 в третьем знаке)
  assert.equal(convert(1, 'USD', 'RUB', parseRate('92.455')), 92);
  // 0.01 USD * 92.465 = 0.92465 -> 0.92
  assert.equal(convert(1, 'USD', 'RUB', parseRate('92.465')), 92);
  // 0.01 USD * 92.5 = 0.925 -> 0.93 (half-up)
  assert.equal(convert(1, 'USD', 'RUB', parseRate('92.5')), 93);
});

test('convert в ту же валюту — тождество', () => {
  assert.equal(convert(123456789, 'RUB', 'RUB', parseRate('7')), 123456789);
});

test('convert устойчив там, где float ошибается', () => {
  // Классика: 0.1 + 0.2 !== 0.3. Проверяем, что суммирование минорных единиц точное.
  const parts = Array.from({ length: 1000 }, () => parseAmount('0,07', 'RUB'));
  assert.equal(parts.reduce((a, b) => a + b, 0), 7000); // ровно 70,00 ₽
});

test('parseAmount разбирает пользовательский ввод', () => {
  assert.equal(parseAmount('2500', 'RUB'), 250000);
  assert.equal(parseAmount('2 500,50', 'RUB'), 250050);
  assert.equal(parseAmount('0,07', 'RUB'), 7);
  assert.equal(parseAmount('1500', 'JPY'), 1500);
  assert.equal(parseAmount(',5', 'RUB'), 50);
});

test('parseAmount округляет лишние знаки half-up без float', () => {
  assert.equal(parseAmount('1,005', 'RUB'), 101);
  assert.equal(parseAmount('1,004', 'RUB'), 100);
});

test('parseAmount отвергает мусор', () => {
  assert.throws(() => parseAmount('abc', 'RUB'));
  assert.throws(() => parseAmount('', 'RUB'));
});

test('formatMoney форматирует по-русски с неразрывными пробелами', () => {
  const N = '\u00A0';
  assert.equal(formatMoney(250000, 'RUB'), `2${N}500${N}₽`);
  assert.equal(formatMoney(250050, 'RUB'), `2${N}500,50${N}₽`);
  assert.equal(formatMoney(-250050, 'RUB'), `−2${N}500,50${N}₽`);
  assert.equal(formatMoney(1500, 'JPY'), `1${N}500${N}¥`);
  assert.equal(formatMoney(250000, 'RUB', { showFraction: 'always' }), `2${N}500,00${N}₽`);
  assert.equal(formatMoney(123456789, 'RUB'), `1${N}234${N}567,89${N}₽`);
});

test('toInputValue — обратная операция к parseAmount', () => {
  for (const s of ['2500,00', '0,07', '123456,78']) {
    assert.equal(toInputValue(parseAmount(s, 'RUB'), 'RUB'), s);
  }
});

test('plural согласует счётные формы по-русски', () => {
  const forms: [string, string, string] = ['операция', 'операции', 'операций'];
  const cases: Array<[number, string]> = [
    [1, 'операция'], [2, 'операции'], [4, 'операции'], [5, 'операций'],
    [11, 'операций'], [12, 'операций'], [14, 'операций'],  // подводный камень: 11–14 всегда третья форма
    [21, 'операция'], [22, 'операции'], [25, 'операций'],
    [48, 'операций'], [101, 'операция'], [111, 'операций'], [0, 'операций'],
  ];
  for (const [n, expected] of cases) {
    assert.equal(plural(n, forms), expected, `${n} → ожидалось «${expected}»`);
  }
  assert.equal(countOf(48, forms), '48 операций');
});
