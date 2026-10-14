/*
 * End-to-end test for index.html, run in headless Chromium.
 *
 * Plays many complete random games from every starting corner. On every
 * turn it compares what the page shows (legal-move dots, clickable squares,
 * burned squares, turn text) against an independent model of the rules
 * written here, so a rules bug in the page cannot hide behind itself.
 *
 * Run with:  npm test
 */
'use strict';

const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const PAGE_URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-results');
const GAMES_PER_CORNER = 8;
const SEED = 12345;

const SIZE = 8;
const KNIGHT_OFFSETS = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const EMBER = '🔥';
const FROST = '❄️';

/* ---------- Helpers ---------- */

/** Small seeded PRNG so failures are reproducible. */
function mulberry32(seed){
  return function(){
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (r, c) => r * SIZE + c;
const sortedKeys = (squares) => squares.map(([r, c]) => key(r, c)).sort((a, b) => a - b);

/** Reference implementation of the rules: where can a knight at `from` jump? */
function expectedMoves(from, other, burned){
  return KNIGHT_OFFSETS
    .map(([dr, dc]) => [from[0] + dr, from[1] + dc])
    .filter(([r, c]) =>
      r >= 0 && r < SIZE && c >= 0 && c < SIZE &&
      !burned.has(key(r, c)) &&
      !(r === other[0] && c === other[1]));
}

/** Reads every square's state from the page. */
function readBoard(page){
  return page.$$eval('.cell', cells => cells.map(cell => ({
    r: Number(cell.dataset.r),
    c: Number(cell.dataset.c),
    disabled: cell.disabled,
    burned: cell.classList.contains('inactive'),
    dot: cell.classList.contains('legal'),
    piece: cell.querySelector('.piece')?.textContent || null,
    label: cell.getAttribute('aria-label')
  })));
}

const clickSquare = (page, r, c) => page.click(`.cell[data-r="${r}"][data-c="${c}"]`);

/* ---------- Test sections ---------- */

/** Plays one full random game with hints on, checking every turn. */
async function playRandomGame(page, random){
  const burned = new Set();
  let mover = EMBER;
  let moves = 0;

  for(;;){
    const board = await readBoard(page);
    const pos = {};
    for(const sq of board){
      if(sq.piece) pos[sq.piece] = [sq.r, sq.c];
      assert.strictEqual(sq.burned, burned.has(key(sq.r, sq.c)), `burned state wrong at ${sq.label}`);
    }

    if(await page.isVisible('#winBanner')){
      const winner = (await page.textContent('#winText')).includes('Ember') ? EMBER : FROST;
      const loser = winner === EMBER ? FROST : EMBER;
      assert.strictEqual(winner, mover === EMBER ? FROST : EMBER, 'winner should be the player who just moved');
      assert.strictEqual(expectedMoves(pos[loser], pos[winner], burned).length, 0, 'loser still had a legal move');
      assert(board.every(sq => sq.disabled), 'squares still clickable after game over');
      assert(!(await page.textContent('#hintText')).includes('Tap a glowing'), 'stale hint text after game over');
      return { winner, moves };
    }

    const opponent = mover === EMBER ? FROST : EMBER;
    const expected = expectedMoves(pos[mover], pos[opponent], burned);
    assert(expected.length > 0, 'current player is stuck but the game is not over');
    assert((await page.textContent('#turnText')).includes(mover === EMBER ? 'Ember' : 'Frost'), 'wrong turn text');
    assert((await page.textContent('#movesLeft')).startsWith(String(expected.length)), 'wrong legal-move count');

    const dots = board.filter(sq => sq.dot).map(sq => [sq.r, sq.c]);
    const clickable = board.filter(sq => !sq.disabled).map(sq => [sq.r, sq.c]);
    assert.deepStrictEqual(sortedKeys(dots), sortedKeys(expected), 'gold dots do not match legal moves');
    assert.deepStrictEqual(sortedKeys(clickable), sortedKeys(expected), 'clickable squares do not match legal moves');

    const [r, c] = expected[Math.floor(random() * expected.length)];
    await clickSquare(page, r, c);
    burned.add(key(...pos[mover]));
    mover = opponent;
    moves++;
  }
}

async function testRandomGames(page){
  const random = mulberry32(SEED);
  const wins = { [EMBER]: 0, [FROST]: 0 };
  let games = 0, moves = 0;

  for(const corner of ['tl', 'tr', 'bl', 'br']){
    if(await page.isVisible('#gameScreen')) await page.click('#restartBtn');
    await page.click(`[data-corner=${corner}]`);
    assert.strictEqual(await page.getAttribute(`[data-corner=${corner}]`, 'aria-pressed'), 'true');
    await page.click('#startBtn');

    for(let i = 0; i < GAMES_PER_CORNER; i++){
      if(i > 0) await page.click('#rematchBtn');
      const result = await playRandomGame(page, random);
      wins[result.winner]++;
      moves += result.moves;
      games++;
    }
  }
  console.log(`  ✓ ${games} random games, ${moves} moves (Ember ${wins[EMBER]} – Frost ${wins[FROST]})`);
}

async function testHintsOff(page){
  await page.click('#rematchBtn');
  await page.click('.switch');

  const board = await readBoard(page);
  assert(board.every(sq => !sq.dot), 'gold dots shown with hints off');
  assert.strictEqual(board.filter(sq => !sq.disabled).length, SIZE * SIZE - 2,
    'with hints off every open square should be clickable');
  assert(board.every(sq => !/legal move/.test(sq.label)), 'labels reveal legal moves with hints off');

  // A square right next to Ember is never a knight move.
  const ember = board.find(sq => sq.piece === EMBER);
  const neighbour = board.find(sq => !sq.piece && Math.abs(sq.r - ember.r) <= 1 && Math.abs(sq.c - ember.c) <= 1);
  await clickSquare(page, neighbour.r, neighbour.c);
  assert((await page.textContent('#hintText')).includes("isn't a legal"), 'no warning for an illegal move');
  assert.strictEqual(await page.textContent('#p1count'), '0', 'illegal move was played');

  const [r, c] = expectedMoves([ember.r, ember.c], [-1, -1], new Set())[0];
  await clickSquare(page, r, c);
  assert.strictEqual(await page.textContent('#p1count'), '1', 'legal move rejected with hints off');
  assert((await page.textContent('#turnText')).includes('Frost'), 'turn did not pass to Frost');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'game.png'), fullPage: true });
  await page.click('.switch'); // restore hints
  console.log('  ✓ hints-off mode');
}

async function testNewSetup(page){
  await page.click('#restartBtn');
  assert(await page.isVisible('#setupScreen'), 'setup screen not shown');
  assert(await page.isDisabled('#startBtn'), 'start button enabled with no corner picked');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'setup.png') });
  console.log('  ✓ new setup resets the corner picker');
}

/* ---------- Runner ---------- */

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });

  // Collect page errors; ignore Google Fonts failing to load (e.g. offline).
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => {
    if(msg.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(msg.text())) errors.push(msg.text());
  });

  try {
    await page.goto(PAGE_URL);
    assert(await page.isDisabled('#startBtn'), 'start button enabled before picking a corner');

    await testRandomGames(page);
    await testHintsOff(page);
    await testNewSetup(page);

    assert.deepStrictEqual(errors, [], 'console errors:\n' + errors.join('\n'));
    console.log('All tests passed.');
  } catch(err){
    console.error('Test failed:', err.message);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'failure.png'), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
